"""
能力执行路由：STT / TTS / 翻译 / LLM 的同步端点与任务处理器

profile 形态（web 端 provider_profiles 解析后随请求传入）：
  {kind: "local"|"cloud", engine?: "whisper"|"edge"|"kokoro"…,
   endpoint_url?, api_key?, model?, params?: {…}}
"""

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import settings
from ..engines import stt_whisper, tts_edge
from ..jobs.runner import Job
from ..providers import openai_compat

router = APIRouter()

# GPU 互斥信号量：STT 推理串行化（单卡显存纪律；TTS/翻译不受限）
_gpu_semaphore = asyncio.Semaphore(1)

# 各能力可覆盖的默认模型
_DEFAULTS = {"stt_model": settings.load_config().get("default_stt_model", "large-v3")}


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


@router.post("/stt")
async def stt(req: STTRequest) -> dict:
    """同步 STT（短音频）：长音频请走 /jobs type=stt（带进度）"""
    audio = _require_pinglc_path(req.audio_path)
    profile = req.profile or {}
    if profile.get("kind") == "cloud":
        text = await openai_compat.transcribe(
            profile["endpoint_url"], profile.get("api_key"),
            profile.get("model", "whisper-1"), audio, language=req.language,
        )
        return {"language": req.language or "", "duration": 0.0, "words": [], "text": text}
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
        job.message = "云端转写中（无词级时间戳，仅兜底）"
        text = await openai_compat.transcribe(
            profile["endpoint_url"], profile.get("api_key"),
            profile.get("model", "whisper-1"), audio,
            language=params.get("language"),
        )
        return {"language": params.get("language") or "", "duration": 0.0, "words": [], "text": text}

    job.message = f"加载模型 {profile.get('model') or _DEFAULTS['stt_model']} …"

    def report(p: float, _job=job):
        _job.progress = p * 0.95
        _job.message = f"转写进度 {p * 100:.0f}%"

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


# ---------------- TTS ----------------


class TTSRequest(BaseModel):
    """单次 TTS 请求（点词/单句朗读）"""

    text: str
    profile: dict = {}
    voice: str | None = None
    rate: str = "+0%"


@router.post("/tts")
async def tts(req: TTSRequest) -> dict:
    """单次合成：返回 mp3 的本地缓存路径（web 代理读取并加缓存头）"""
    profile = req.profile or {}
    if profile.get("kind") == "cloud":
        raise HTTPException(status_code=501, detail="云端 TTS 透传在需要时再接入")
    voice = req.voice or profile.get("model") or tts_edge.DEFAULT_VOICE
    data = await tts_edge.synthesize(req.text, voice=voice, rate=req.rate)
    # 写到缓存目录并把路径回给 web（web 直接 fs 读取同一路径）
    from ..engines.tts_edge import _cache_path  # noqa: PLC0415

    path = _cache_path(req.text, voice, req.rate)
    return {"path": str(path), "size": len(data)}


class TTSBatchRequest(BaseModel):
    """批量 TTS 请求（文本导入）：逐句合成 + 静音间隔 + 拼接"""

    sentences: list[str]
    out_path: str
    profile: dict = {}
    voice: str | None = None
    rate: str = "+0%"


@router.post("/tts/batch")
async def tts_batch_sync(req: TTSBatchRequest) -> dict:
    """同步批量合成（句子数适中时直接等；大批量走 /jobs type=tts_batch）"""
    out = _require_pinglc_path(req.out_path)
    voice = req.voice or (req.profile or {}).get("model") or tts_edge.DEFAULT_VOICE
    timeline = await tts_edge.synthesize_batch(req.sentences, out, voice=voice, rate=req.rate)
    return {"path": out, "timeline": timeline}


async def tts_batch_job_handler(params: dict, job: Job) -> dict:
    """批量 TTS 任务处理器（文本导入主路径）"""

    def report(p: float):
        job.progress = p
        job.message = f"语音合成 {p * 100:.0f}%"

    out = _require_pinglc_path(params["out_path"])
    voice = params.get("voice") or (params.get("profile") or {}).get("model") or tts_edge.DEFAULT_VOICE
    timeline = await tts_edge.synthesize_batch(
        params["sentences"], out, voice=voice,
        rate=params.get("rate", "+0%"), on_progress=report,
    )
    return {"path": out, "timeline": timeline}


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


# ---------------- LLM ----------------


class LLMRequest(BaseModel):
    """LLM 请求：AI 解析 / 单词笔记 / 关卡生成等（M1 非流式）"""

    profile: dict
    system: str | None = None
    user: str
    temperature: float | None = None
    want_json: bool = False


@router.post("/llm/chat")
async def llm_chat(req: LLMRequest) -> dict:
    """LLM 单轮调用（多轮由 web 拼好 messages 传 user/system —— M3 再扩展多轮参数）"""
    profile = req.profile
    if profile.get("kind") != "cloud":
        raise HTTPException(status_code=400, detail="LLM 档案必须提供云端 OpenAI 兼容端点")
    messages: list[dict] = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.append({"role": "user", "content": req.user})
    try:
        if req.want_json:
            content = await openai_compat.chat_json(
                profile["endpoint_url"], profile.get("api_key"), profile["model"],
                messages, temperature=req.temperature,
            )
            return {"content": None, "json": content}
        text = await openai_compat.chat(
            profile["endpoint_url"], profile.get("api_key"), profile["model"],
            messages, temperature=req.temperature,
        )
        return {"content": text, "json": None}
    except openai_compat.OpenAICompatError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


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
