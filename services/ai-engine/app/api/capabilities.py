"""
能力执行路由：STT / TTS / 翻译 / 口语评测 / LLM 的同步端点与任务处理器

profile 形态（web 端 provider_profiles 解析后随请求传入）：
  {kind: "local"|"cloud", endpoint_url?, api_key?, model?, params?: {…}}
TTS 的本地双引擎（edge 联网 / kokoro 离线）由 params.engine 路由（缺省=edge）；
口语评测（/soe）无本地实现，仅支持云端档案（腾讯云 SOE）。
"""

import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import orjson
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import settings
from ..engines import soe_tencent, stt_whisper, tts_edge, tts_kokoro
from ..jobs.runner import Job
from ..providers import aliyun_native, llm_formats, openai_compat

router = APIRouter()

# GPU 互斥信号量：STT 推理串行化（单卡显存纪律；TTS/翻译不受限）
_gpu_semaphore = asyncio.Semaphore(1)

# 各能力可覆盖的默认模型
_DEFAULTS = {"stt_model": settings.load_config().get("default_stt_model", "large-v3")}


def _reporter(job: Job, base: float = 0.0, scale: float = 1.0, label: str = "语音合成"):
    """任务进度上报闭包工厂：progress = base + p×scale，message 取回调文案或「label N%」

    各任务处理器（云端/下载/kokoro/edge 合成、STT 分片、whisper 转写）此前
    各手写一份只差 base/scale/label 的闭包——改上报口径要同步五处。回调签名
    兼容两种：(p) 与 (p, msg)。
    """

    def report(p: float, msg: str | None = None):
        job.progress = base + p * scale
        job.message = msg if msg is not None else f"{label} {p * 100:.0f}%"

    return report


def _cloud_api_path(profile: dict) -> str | None:
    """云端档案的专属端点路径（params.apiPath）：非空 → 阿里云原生 API，否则 OpenAI 兼容体系

    路径归一：实测正确路由带 /api/v1 前缀（…/api/v1/services/aigc/multimodal-generation/
    generation）；/services/… 短形式自动补全，粘贴完整 URL 取其 path——两种写法
    等效。非阿里云体系的输入（如 OpenAI 的 /v1/audio/transcriptions）直接报
    配置错误：此前会给它硬拼 /api/v1 前缀静默造出一个必 404 的地址，错误
    只能以「云端返回 404」的样子出现，无从定位。
    Raises:
        HTTPException: 400（端点路径不是阿里云原生 /services/ 体系）
    """
    raw = (profile.get("params") or {}).get("apiPath")
    if not isinstance(raw, str) or not raw.strip():
        return None
    # 粘贴完整 URL 时取 path 部分（https://…/api/v1/services/… → /api/v1/services/…）
    if "://" in raw:
        raw = urlparse(raw).path
    path = "/" + raw.strip().lstrip("/")
    if not path.startswith("/api/v1/"):
        path = f"/api/v1{path}"  # /services/… 短形式补全
    if not path.startswith("/api/v1/services/"):
        raise HTTPException(
            status_code=400,
            detail="端点路径仅支持阿里云原生 API（/services/… 开头）；OpenAI 兼容端点请留空",
        )
    return path


class CloudProfile(BaseModel):
    """云端 OpenAI 兼容档案（随请求传入，引擎不落库）"""

    kind: str = "cloud"
    endpoint_url: str
    api_key: str | None = None
    model: str
    params: dict = {}


# ---------------- STT ----------------


class STTRequest(BaseModel):
    """STT 请求：本地 whisper 或云端转写"""

    audio_path: str
    profile: dict = {}
    language: str | None = "en"
    initial_prompt: str | None = None


def _require_pinglc_path(path: str) -> str:
    """路径安全：引擎只读写 ~/.pinglc/ 之内的文件（web 是唯一调用方，防御纵深）"""
    from pathlib import Path

    resolved = Path(path).resolve()
    home = Path(settings.PINGLC_HOME).resolve()
    if resolved != home and home not in resolved.parents:
        raise HTTPException(status_code=403, detail="路径越出 ~/.pinglc")
    return str(resolved)


def _cloud_stt_payload(language: str | None, text: str, words: list) -> dict:
    """云端 STT 响应统一构造（同步 /stt 与 stt 任务处理器共用；此前四处手写字面量，
    加字段漏一处即同步/任务两路径返回形状分叉）"""
    return {"language": language or "", "duration": 0.0, "words": words, "text": text}


async def _cloud_stt_text(
    profile: dict, audio: str, language: str | None, on_progress=None
) -> tuple[str, list]:
    """云端 STT 统一分发：apiPath → 阿里云原生（词级时间戳、超限自动分片）；
    否则 OpenAI 兼容（无词级时间戳，兜底）。同步端点与任务处理器共用此一个入口。

    Args:
        on_progress: 分片转写进度回调（(0~1, 文案)；直发/兼容路径不回调）
    Returns:
        (全文文本, 词级列表)
    Raises:
        openai_compat.OpenAICompatError: 网络/HTTP/响应结构异常
    """
    api_path = _cloud_api_path(profile)
    if api_path:
        result = await aliyun_native.transcribe_long(
            profile["endpoint_url"], profile.get("api_key"),
            profile.get("model") or aliyun_native.DEFAULT_STT_MODEL, audio,
            api_path=api_path, on_progress=on_progress,
        )
        return result["text"], result["words"]
    text = await openai_compat.transcribe(
        profile["endpoint_url"], profile.get("api_key"),
        profile.get("model", "whisper-1"), audio, language=language,
    )
    return text, []


@router.post("/stt")
async def stt(req: STTRequest) -> dict:
    """同步 STT（短音频）：长音频请走 /jobs type=stt（带进度）"""
    audio = _require_pinglc_path(req.audio_path)
    profile = req.profile or {}
    if profile.get("kind") == "cloud":
        try:
            text, words = await _cloud_stt_text(profile, audio, req.language)
        except openai_compat.OpenAICompatError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return _cloud_stt_payload(req.language, text, words)
    # 本地 faster-whisper（放线程池跑阻塞推理；GPU 串行）
    async with _gpu_semaphore:
        result = await asyncio.to_thread(
            stt_whisper.transcribe,
            audio,
            model_spec=profile.get("model") or _DEFAULTS["stt_model"],
            language=req.language,
            device=profile.get("params", {}).get("device"),
            initial_prompt=req.initial_prompt,
        )
    return {
        "language": result.language,
        "duration": result.duration,
        "words": result.words,
    }


async def stt_job_handler(params: dict, job: Job) -> dict:
    """STT 任务处理器（长音频）：逐段上报进度"""
    audio = _require_pinglc_path(params["audio_path"])
    profile = params.get("profile") or {}
    if profile.get("kind") == "cloud":
        # 文案按实际路由设定（apiPath → 阿里云原生分片；否则 OpenAI 兼容兜底）——
        # 先判后写，兼容路径顶着「阿里云原生」文案会误导排障
        if _cloud_api_path(profile):
            job.message = "云端转写中（阿里云原生 API，超限自动分片）…"
        else:
            job.message = "云端转写中（OpenAI 兼容，无词级时间戳，仅兜底）"
        # 分片进度直通任务进度（文案由 aliyun_native.transcribe_long 给出）
        try:
            text, words = await _cloud_stt_text(
                profile, audio, params.get("language"), on_progress=_reporter(job)
            )
        except openai_compat.OpenAICompatError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return _cloud_stt_payload(params.get("language"), text, words)

    job.message = f"加载模型 {profile.get('model') or _DEFAULTS['stt_model']} …"

    report = _reporter(job, scale=0.95, label="转写进度")

    async with _gpu_semaphore:
        result = await asyncio.to_thread(
            stt_whisper.transcribe,
            audio,
            model_spec=profile.get("model") or _DEFAULTS["stt_model"],
            language=params.get("language", "en"),
            device=profile.get("params", {}).get("device"),
            initial_prompt=params.get("initial_prompt"),
            on_progress=report,
        )
    job.message = "转写完成"
    return {
        "language": result.language,
        "duration": result.duration,
        "words": result.words,
    }


# ---------------- TTS（edge-tts 联网 / kokoro 本地离线，按档案 params.engine 路由） ----------------


def _tts_engine(profile: dict) -> str:
    """从档案解析 TTS 引擎名：params.engine == "kokoro" 走本地离线，其余（含缺省）走 edge"""
    engine = (profile.get("params") or {}).get("engine")
    return "kokoro" if engine == "kokoro" else "edge"


def _resolve_tts(profile: dict, req_voice: str | None) -> tuple[str, str]:
    """解析 TTS 引擎与音色（/tts、/tts/batch、tts_batch 任务处理器共用）

    引擎由档案 params.engine 路由；音色优先级：请求显式指定 > 档案 model > 引擎默认。
    Returns:
        (engine, voice) 二元组
    """
    engine = _tts_engine(profile)
    default = tts_kokoro.DEFAULT_VOICE if engine == "kokoro" else tts_edge.DEFAULT_VOICE
    return engine, req_voice or profile.get("model") or default


class TTSRequest(BaseModel):
    """单次 TTS 请求（点词/单句朗读）"""

    text: str
    profile: dict = {}
    voice: str | None = None
    rate: str = "+0%"


def _cloud_tts_voice(profile: dict, req_voice: str | None) -> str:
    """云端 TTS（阿里云原生）音色解析：请求显式指定 > 档案 params.voice > 默认音色

    注意档案 model 字段在云端 TTS 是模型名（默认 qwen-audio-3.0-tts-plus），不作音色用。
    """
    return req_voice or (profile.get("params") or {}).get("voice") or aliyun_native.DEFAULT_TTS_VOICE


@router.post("/tts")
async def tts(req: TTSRequest) -> dict:
    """单次合成：返回音频的本地缓存路径（web 代理读取并加缓存头）

    kokoro 返回 wav 缓存路径（扩展名 .wav，web 按扩展名给 Content-Type）；
    模型未下载时同步返回 503 + 指引（不静默触发 336MB 大下载）。
    云端档案走阿里云 WebSocket 实时合成（由端点 URL 推 WS 地址，无需 apiPath），
    逐次合成都落内容哈希缓存；三路统一 ensure 语义——缓存命中不把音频
    字节读回引擎，size 由调用方 stat（web 代理是唯一读取方）。
    """
    profile = req.profile or {}
    if profile.get("kind") == "cloud":
        voice = _cloud_tts_voice(profile, req.voice)
        try:
            path = await aliyun_native.ensure_synthesized(
                profile["endpoint_url"], profile.get("api_key"), profile.get("model"),
                req.text, voice=voice,
            )
        except openai_compat.OpenAICompatError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"path": str(path), "size": path.stat().st_size}
    engine, voice = _resolve_tts(profile, req.voice)
    if engine == "kokoro":
        speed = tts_kokoro.parse_rate(req.rate)
        try:
            path = await asyncio.to_thread(
                tts_kokoro.ensure_synthesized, req.text, voice=voice, speed=speed
            )
        except tts_kokoro.TTSEngineError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"path": str(path), "size": path.stat().st_size}
    data = await tts_edge.synthesize(req.text, voice=voice, rate=req.rate)
    # 写到缓存目录并把路径回给 web（web 直接 fs 读取同一路径）
    path = tts_edge.cache_path(req.text, voice, req.rate)
    return {"path": str(path), "size": len(data)}


@router.get("/tts/voices")
async def tts_voices() -> dict:
    """TTS 音色清单与各引擎默认音色（web 设置页档案表单下拉用；纯静态数据，不依赖模型在位）

    - edge / kokoro：本地双引擎清单；cloud：阿里云系统音色清单——三份清单只在
      引擎各持一份，web 不再硬编码任何音色（含默认值）
    - defaults：三引擎默认音色（表单留空时的兜底，展示在 placeholder）
    """
    return {
        "edge": tts_edge.VOICE_OPTIONS,
        "kokoro": tts_kokoro.VOICE_OPTIONS,
        "cloud": aliyun_native.VOICE_OPTIONS,
        "defaults": {
            "edge": tts_edge.DEFAULT_VOICE,
            "kokoro": tts_kokoro.DEFAULT_VOICE,
            "cloud": aliyun_native.DEFAULT_TTS_VOICE,
        },
    }


async def _cloud_tts_batch(
    sentences: list[str],
    out_path: str,
    profile: dict,
    voice: str,
    on_progress=None,
) -> list[dict]:
    """云端 TTS（阿里云 WebSocket）批量合成：逐句合成 mp3 分片（内容哈希缓存）
    → ffprobe 测长 → 静音间隔拼接（与 edge 路径同一拼装语义）

    并发度 4（信号量限流，与 tts_edge.synthesize_batch 同款）：逐句串行时
    500 句要付 500 次网络往返，每句还各开一条 WS 连接。"""
    from ..engines.tts_common import assemble_timeline  # noqa: PLC0415

    out_dir = Path(out_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / ".tts-parts"
    work.mkdir(exist_ok=True)

    sem = asyncio.Semaphore(4)
    done = 0

    async def one(i: int, text: str) -> None:
        """单句合成落分片（信号量内执行；进度按完成句数计，事件循环内计数无竞态）"""
        nonlocal done
        async with sem:
            data = await aliyun_native.synthesize(
                profile["endpoint_url"], profile.get("api_key"), profile.get("model"),
                text, voice=voice,
            )
        (work / f"{i:05d}.mp3").write_bytes(data)
        done += 1
        if on_progress:
            on_progress(done / (len(sentences) + 1))

    # TaskGroup（3.11+）：任一句失败自动取消同级在飞任务——gather 的 fail-fast
    # 只抛首个异常、其余任务继续跑完并改写已失败任务的进度；异常组里剥出
    # 领域错误原样上抛（任务错误文案保持可读）
    try:
        async with asyncio.TaskGroup() as tg:
            for i, text in enumerate(sentences):
                tg.create_task(one(i, text))
    except* openai_compat.OpenAICompatError as eg:
        raise eg.exceptions[0] from None
    parts = [str(work / f"{i:05d}.mp3") for i in range(len(sentences))]

    return assemble_timeline(parts, out_path, on_progress=on_progress)


class TTSBatchRequest(BaseModel):
    """批量 TTS 请求（文本导入）：逐句合成 + 静音间隔 + 拼接"""

    sentences: list[str]
    out_path: str
    profile: dict = {}
    voice: str | None = None
    rate: str = "+0%"


@router.post("/tts/batch")
async def tts_batch_sync(req: TTSBatchRequest) -> dict:
    """同步批量合成（句子数适中时直接等；大批量走 /jobs type=tts_batch）

    kokoro 同步路径要求模型已在位（首装请走任务路径或设置页下载，避免请求
    挂在分钟级下载上）。
    """
    out = _require_pinglc_path(req.out_path)
    profile = req.profile or {}
    # 云端档案（阿里云 WebSocket，由端点 URL 推 WS 地址）：逐句合成后共享拼装
    if profile.get("kind") == "cloud":
        try:
            timeline = await _cloud_tts_batch(req.sentences, out, profile, _cloud_tts_voice(profile, req.voice))
        except openai_compat.OpenAICompatError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"path": out, "timeline": timeline}
    engine, voice = _resolve_tts(profile, req.voice)
    if engine == "kokoro":
        try:
            timeline = await asyncio.to_thread(
                tts_kokoro.synthesize_batch, req.sentences, out,
                voice=voice, speed=tts_kokoro.parse_rate(req.rate),
            )
        except tts_kokoro.TTSEngineError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"path": out, "timeline": timeline}
    timeline = await tts_edge.synthesize_batch(req.sentences, out, voice=voice, rate=req.rate)
    return {"path": out, "timeline": timeline}


async def tts_batch_job_handler(params: dict, job: Job) -> dict:
    """批量 TTS 任务处理器（文本导入主路径）

    kokoro 首次使用在此自动补模型（0~25% 进度带文案）——但先过包可导入
    检查（未装 kokoro-onnx 时下载 336MB 毫无意义，下载完照样 ImportError）；
    edge 路径与原逻辑一致。
    """
    out = _require_pinglc_path(params["out_path"])
    profile = params.get("profile") or {}
    # 云端档案（阿里云 WebSocket）：逐句并发合成 + 进度上报
    if profile.get("kind") == "cloud":
        timeline = await _cloud_tts_batch(
            params["sentences"], out, profile, _cloud_tts_voice(profile, params.get("voice")),
            on_progress=_reporter(job, label="云端语音合成"),
        )
        return {"path": out, "timeline": timeline}
    engine, voice = _resolve_tts(profile, params.get("voice"))

    if engine == "kokoro":
        if not tts_kokoro.module_ready():
            raise tts_kokoro.TTSEngineError(
                "kokoro-onnx 未安装：运行 ./scripts/engine-setup.sh 安装 tts 层"
            )
        speed = tts_kokoro.parse_rate(params.get("rate", "+0%"))
        if not tts_kokoro.models_ready():
            # 联网补缺模型：先查本地，缺哪个补哪个（进度占前 1/4）
            await asyncio.to_thread(tts_kokoro.ensure_models, _reporter(job, scale=0.25))

        timeline = await asyncio.to_thread(
            tts_kokoro.synthesize_batch, params["sentences"], out,
            voice=voice, speed=speed, on_progress=_reporter(job, base=0.25, scale=0.75),
        )
        return {"path": out, "timeline": timeline}

    timeline = await tts_edge.synthesize_batch(
        params["sentences"], out, voice=voice,
        rate=params.get("rate", "+0%"), on_progress=_reporter(job),
    )
    return {"path": out, "timeline": timeline}


# ---------------- 本地引擎模型下载任务 ----------------


async def model_download_job_handler(params: dict, job: Job) -> dict:
    """模型下载任务处理器（设置页「下载 kokoro 模型」按钮）

    本地优先：ensure_models 先查 ~/.pinglc/models/kokoro/，在位的文件
    直接复用（支持手工放置做离线迁移），只下载缺失部分。
    先过包可导入检查——未装 kokoro-onnx 时 336MB 下载是纯浪费。
    """
    target = params.get("engine", "kokoro")
    if target != "kokoro":
        raise ValueError(f"不支持的下载目标: {target}（当前仅 kokoro）")
    if not tts_kokoro.module_ready():
        raise tts_kokoro.TTSEngineError(
            "kokoro-onnx 未安装：运行 ./scripts/engine-setup.sh 安装 tts 层（无需下载模型）"
        )

    downloaded = await asyncio.to_thread(tts_kokoro.ensure_models, _reporter(job))
    job.message = "模型已就绪" if not downloaded else "下载完成"
    return {"engine": "kokoro", "downloaded": downloaded, "dir": str(tts_kokoro.KOKORO_DIR)}


# ---------------- 翻译 ----------------


class TranslateRequest(BaseModel):
    """翻译请求：texts 批量，方向 en↔zh（需求 9 中英互译）"""

    texts: list[str]
    profile: dict
    direction: str = "en2zh"  # en2zh | zh2en


# 翻译系统提示（hy-MT2 与通用 LLM 通用：输出 JSON 数组，逐条对应输入）
_TRANSLATE_SYSTEM = (
    "You are a professional translator. Translate each item in the user's JSON array "
    "from {src} to {dst}. Preserve original formatting and punctuation. "
    "Return ONLY a JSON array of translated strings, same length and order as input. "
    "Do not add explanations."
)


@router.post("/translate")
async def translate(req: TranslateRequest) -> dict:
    """批量翻译（同步，≤40 条/批；更大批量由 web 拆批循环调用并记进度）"""
    if not req.texts:
        return {"translations": []}
    if len(req.texts) > 40:
        raise HTTPException(status_code=400, detail="单批最多 40 条（web 负责拆批）")
    profile = req.profile
    if profile.get("kind") != "cloud":
        raise HTTPException(status_code=400, detail="翻译档案必须提供云端 OpenAI 兼容端点")
    src, dst = ("English", "Chinese") if req.direction == "en2zh" else ("Chinese", "English")
    messages = [
        {"role": "system", "content": _TRANSLATE_SYSTEM.format(src=src, dst=dst)},
        {"role": "user", "content": _to_json_str(req.texts)},
    ]
    try:
        result = await openai_compat.chat_json(
            profile["endpoint_url"], profile.get("api_key"), profile["model"], messages,
            temperature=0.1,
        )
    except openai_compat.OpenAICompatError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    translations = _as_str_list(result, len(req.texts))
    return {"translations": translations}


def _to_json_str(obj: Any) -> str:
    """orjson 序列化（ensure ascii 关闭，中文原文直传省 token）"""
    import orjson

    return orjson.dumps(obj, option=orjson.OPT_APPEND_NEWLINE).decode("utf-8")


def _as_str_list(result: Any, expected: int) -> list[str]:
    """把模型 JSON 输出规整为等长字符串数组；长度不符时尽力对齐"""
    if isinstance(result, str):
        result = [result]
    if not isinstance(result, list):
        raise HTTPException(status_code=502, detail=f"翻译返回了非数组：{type(result).__name__}")
    out = [str(x) if not isinstance(x, str) else x for x in result]
    if len(out) < expected:  # 少了：缺位用原文占位（web 端标记未译）
        out += [""] * (expected - len(out))
    return out[:expected]


# ---------------- 口语评测（腾讯云 SOE 录音文件模式；仅云端档案） ----------------


class SOERequest(BaseModel):
    """口语评测请求：录音文件 + 参考文本 + speech_eval 云端档案"""

    audio_path: str
    ref_text: str
    profile: dict = {}
    language: str = "en"


@router.post("/soe")
async def soe(req: SOERequest) -> dict:
    """录音文件口语评测（同步，音频上限 60s）：词级 + 音素级评分

    凭据从 speech_eval 档案读取：endpoint_url=服务地址、api_key=SecretKey、
    params={provider, appId, secretId, scoreCoeff?}；本地无口语评测引擎，档案
    必须为云端（未配置时 web 端走本地 STT 近似评分兜底，不会请求本端点）。
    """
    audio = _require_pinglc_path(req.audio_path)
    profile = req.profile or {}
    if profile.get("kind") != "cloud":
        raise HTTPException(status_code=400, detail="口语评测档案必须为云端（设置页 → 口语评测）")
    params = profile.get("params") or {}
    provider = params.get("provider", "tencent")
    if provider != "tencent":
        raise HTTPException(status_code=400, detail=f"暂不支持的口语评测服务商：{provider}")
    app_id = params.get("appId")
    secret_id = params.get("secretId")
    secret_key = profile.get("api_key")
    if not (app_id and secret_id and secret_key):
        raise HTTPException(
            status_code=400,
            detail="口语评测档案缺少 AppId / SecretId / SecretKey（设置页补全后重试）",
        )
    try:
        return await soe_tencent.evaluate(
            audio,
            req.ref_text,
            endpoint=profile.get("endpoint_url") or soe_tencent.DEFAULT_ENDPOINT,
            app_id=str(app_id),
            secret_id=str(secret_id),
            secret_key=str(secret_key),
            score_coeff=params.get("scoreCoeff"),
            language=req.language,
        )
    except soe_tencent.SoeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ---------------- LLM ----------------


class LLMRequest(BaseModel):
    """LLM 请求：AI 解析 / 单词笔记 / 关卡生成等（非流式）"""

    profile: dict
    system: str | None = None
    user: str
    temperature: float | None = None
    want_json: bool = False


class LLMStreamRequest(BaseModel):
    """LLM 流式请求（AI 侍读）：完整多轮 messages，SSE 增量返回"""

    profile: dict
    messages: list[dict]
    temperature: float | None = None


@router.post("/llm/chat")
async def llm_chat(req: LLMRequest) -> dict:
    """LLM 单轮调用（多轮由 web 拼好 messages 传 user/system —— M3 再扩展多轮参数）"""
    profile = req.profile
    if profile.get("kind") != "cloud":
        raise HTTPException(status_code=400, detail="LLM 档案必须提供云端端点")
    # API 格式按档案 params.apiFormat 分发（缺省/未知回落 OpenAI 兼容）
    api_format = (profile.get("params") or {}).get("apiFormat")
    messages: list[dict] = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.append({"role": "user", "content": req.user})
    try:
        if req.want_json:
            content = await llm_formats.chat_json(
                api_format, profile["endpoint_url"], profile.get("api_key"), profile["model"],
                messages, temperature=req.temperature,
            )
            return {"content": None, "json": content}
        text = await llm_formats.chat(
            api_format, profile["endpoint_url"], profile.get("api_key"), profile["model"],
            messages, temperature=req.temperature,
        )
        return {"content": text, "json": None}
    except openai_compat.OpenAICompatError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class LLMModelsRequest(BaseModel):
    """云端模型清单请求（设置页「获取模型」按钮，供模型下拉填充）"""

    endpoint_url: str
    api_key: str | None = None
    api_format: str | None = None


@router.post("/llm/models")
async def llm_models(req: LLMModelsRequest) -> dict:
    """拉取云端模型清单（按档案 API 格式分发：OpenAI 方言 / Anthropic / Gemini）"""
    try:
        models = await llm_formats.list_models(req.api_format, req.endpoint_url, req.api_key)
    except openai_compat.OpenAICompatError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"models": models}


# ---------------- 媒体 ----------------


class ProbeRequest(BaseModel):
    """媒体探测请求"""

    path: str


@router.post("/media/probe")
async def media_probe(req: ProbeRequest) -> dict:
    """ffprobe 元数据（web 在导入后取时长/尺寸）"""
    from ..media import ffmpeg  # noqa: PLC0415

    path = _require_pinglc_path(req.path)
    try:
        return await asyncio.to_thread(ffmpeg.probe, path)
    except ffmpeg.MediaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class ExtractAudioRequest(BaseModel):
    """音频抽取请求"""

    source: str
    out_wav: str


@router.post("/media/extract-audio")
async def media_extract(req: ExtractAudioRequest) -> dict:
    """抽取 16kHz wav（STT 前置；视频与音频统一走此路径）"""
    from ..media import ffmpeg  # noqa: PLC0415

    src = _require_pinglc_path(req.source)
    out = _require_pinglc_path(req.out_wav)
    try:
        await asyncio.to_thread(ffmpeg.extract_audio, src, out)
    except ffmpeg.MediaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"path": out}


class SliceRequest(BaseModel):
    """单句切片请求（重 STT）"""

    source: str
    start_ms: int
    end_ms: int
    out_path: str


@router.post("/media/slice")
async def media_slice(req: SliceRequest) -> dict:
    """按时间切 16kHz wav 片段"""
    from ..media import ffmpeg  # noqa: PLC0415

    src = _require_pinglc_path(req.source)
    out = _require_pinglc_path(req.out_path)
    try:
        await asyncio.to_thread(
            ffmpeg.slice_audio, src, req.start_ms, req.end_ms, out
        )
    except ffmpeg.MediaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"path": out}


class PeaksRequest(BaseModel):
    """波形峰值请求"""

    path: str
    buckets: int = 2000


@router.post("/media/peaks")
async def media_peaks(req: PeaksRequest) -> dict:
    """波形峰值数组（播放页 canvas 渲染）"""
    from ..media import ffmpeg  # noqa: PLC0415

    path = _require_pinglc_path(req.path)
    try:
        values = await asyncio.to_thread(ffmpeg.peaks, path, req.buckets)
    except ffmpeg.MediaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"peaks": values}


# ---------------- 链接下载任务 ----------------


async def yt_download_job_handler(params: dict, job: Job) -> dict:
    """yt-dlp 下载任务处理器"""
    from ..media import ytdlp  # noqa: PLC0415

    out_dir = _require_pinglc_path(params["out_dir"])
    job.message = "链接解析与下载中…"

    def report(p: float):
        job.progress = p * 0.9
        job.message = f"下载 {p * 100:.0f}%"

    result = await asyncio.to_thread(
        ytdlp.download,
        params["url"],
        out_dir,
        want_video=params.get("want_video", True),
        on_progress=report,
    )
    job.message = "下载完成"
    job.progress = 1.0
    return result


@router.post("/llm/chat/stream")
async def llm_chat_stream(req: LLMStreamRequest):
    """流式对话（AI 侍读）：云端 SSE → 引擎 SSE 透传（text/event-stream）"""
    from fastapi.responses import StreamingResponse  # noqa: PLC0415

    profile = req.profile
    if profile.get("kind") != "cloud":
        raise HTTPException(status_code=400, detail="LLM 档案必须提供云端端点")
    # API 格式按档案 params.apiFormat 分发（缺省/未知回落 OpenAI 兼容）
    api_format = (profile.get("params") or {}).get("apiFormat")

    async def gen():
        try:
            async for piece in llm_formats.chat_stream(
                api_format, profile["endpoint_url"], profile.get("api_key"), profile["model"],
                req.messages, temperature=req.temperature,
            ):
                # SSE 数据行（增量 JSON，避免裸文本里的换行破坏协议）
                yield f"data: {orjson.dumps({'delta': piece}).decode()}\n\n"
        except openai_compat.OpenAICompatError as exc:
            yield f"data: {orjson.dumps({'error': str(exc)}).decode()}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
