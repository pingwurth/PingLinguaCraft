"""
阿里云千问原生 API 适配（token-plan/MaaS 套餐域名，协议经实测校准）

- STT（HTTP 多模态生成）：POST {url}/api/v1/services/aigc/multimodal-generation/generation
  · 请求头 X-DashScope-SSE: disable（禁用默认 SSE 流，取同步 JSON）
  · content 类型 input_audio + data URL（base64 内嵌，≤8MB）
  · parameters.format/sample_rate 声明音频格式
  · 响应 sentence.text + sentence.words[]（词级时间戳 begin/end 毫秒 → 映射引擎 words）
- TTS（WebSocket 实时合成）：wss://{host}/api-ws/v1/inference
  · HTTP 头鉴权 Authorization: bearer {key}（x-authorization 字段不被该网关接受）
  · run-task：payload.input.text + parameters.voice/format/sample_rate
  · 二进制帧拼音频，task-finished 收尾；音色如 longanlingxin/longanlufeng
与 openai_compat 的分工：档案 params.apiPath 存在 → 本模块；否则 → openai_compat（…/v1 体系）。
"""

import asyncio
import base64
import json
import math
import shutil
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from ..ws_session import WsSession
from .openai_compat import OpenAICompatError, make_client

# 单次内嵌音频的体积上限（base64 前的原始字节）：平台限制 10MB，留余量
MAX_AUDIO_BYTES = 8 * 1024 * 1024

# 默认模型与音色（设置页模型/音色留空时的兜底；音色清单见千问平台 Qwen-Audio-TTS 页）
DEFAULT_STT_MODEL = "qwen-audio-3.0-asr-flash"
DEFAULT_TTS_MODEL = "qwen-audio-3.0-tts-plus"
DEFAULT_TTS_VOICE = "longanlingxin"

# 云端 TTS 系统音色清单（单一来源：经 /tts/voices 的 cloud 字段透传给 web 设置页
# 下拉；仅列系统音色，500+ 基础音色 qwen-audio-3.0-tts-{plus|flash}-xxx 由用户手输。
# 与本地双引擎的 VOICE_OPTIONS 同构：{value=音色 id, label=中文展示}）
VOICE_OPTIONS: list[dict] = [
    {"value": "longanlingxin", "label": "龙安灵心 · 女 · 知心温暖 · plus 旗舰"},
    {"value": "longanlufeng", "label": "龙安鲁风 · 男 · 明亮开朗 · plus 旗舰"},
    {"value": "longanfengyue", "label": "龙安风悦 · 女 · 自然亲切 · flash"},
    {"value": "longanyuanfei", "label": "龙安元妃 · 女 · 高傲妃子音 · flash"},
    {"value": "longanxiaoxin", "label": "龙安小昕 · 女 · 亲切活泼 · flash"},
    {"value": "loongmary", "label": "loongmary · 女 · 温暖英音 · flash"},
    {"value": "loongjohn", "label": "loongjohn · 男 · 沉稳美音 · flash"},
]

# TTS 输出参数（与套餐模型实测一致：mp3 / 22050Hz）
TTS_SAMPLE_RATE = 22050


def full_url(endpoint_url: str, api_path: str) -> str:
    """拼接完整调用地址：端点 URL（域名基址）+ 端点路径（/services/… 专属路径）"""
    return f"{endpoint_url.rstrip('/')}/{api_path.lstrip('/')}"


def ws_url(endpoint_url: str) -> str:
    """由档案端点 URL 推 WebSocket 合成地址：https 域名 → wss://{host}/api-ws/v1/inference"""
    host = urlparse(endpoint_url).netloc
    if not host:
        raise OpenAICompatError(f"端点 URL 无效：{endpoint_url}")
    return f"wss://{host}/api-ws/v1/inference"


def _mime_for(path: str) -> str:
    """按扩展名推音频 MIME（data URL 用；未识别回退 wav）"""
    return {
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }.get(Path(path).suffix.lower(), "audio/wav")


def cache_path(text: str, model: str, voice: str, endpoint_url: str = "") -> Path:
    """云端 TTS 合成缓存路径（"cloud|model|voice|host|text" 的 sha256 → mp3）

    host（端点的 netloc）进键：不同云端端点/网关的档案各自隔离缓存——
    同 model+voice 但服务方不同（token-plan 域 vs MaaS 域 vs 中转）时，
    A 档案合成的音频不该被 B 档案的内容哈希缓存直接命中。
    cloud| 前缀与本地引擎（edge/kokoro）键空间隔离；哈希与落位走
    tts_common.tts_cache_path 单一实现。
    """
    from ..engines.tts_common import tts_cache_path  # noqa: PLC0415 —— 惰性导入，避免循环依赖

    host = urlparse(endpoint_url).netloc if endpoint_url else ""
    return tts_cache_path(f"cloud|{model}|{voice}|{host}|{text.strip()}", "mp3")


async def transcribe(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    audio_path: str,
    *,
    api_path: str,
    language: str | None = None,
) -> dict:
    """云端转写（多模态生成）：音频 base64 内嵌，返回 {text, words}

    Args:
        endpoint_url: 域名基址（如 https://token-plan.cn-beijing.maas.aliyuncs.com）
        api_key:      Bearer 令牌
        model:        模型名（如 qwen-audio-3.0-asr-flash）
        audio_path:   音频文件绝对路径（≤ MAX_AUDIO_BYTES；超限由调用方分片）
        api_path:     接口路径（/api/v1/services/aigc/multimodal-generation/generation）
        language:     未使用（此协议按 parameters 声明音频格式，语言自动检测）
    Returns:
        {"text": 全文, "words": [{w,s,e,p?}, …]}（words 时间戳由毫秒转秒）
    Raises:
        OpenAICompatError: 网络/HTTP/响应结构/音频超限
    """
    raw = Path(audio_path).read_bytes()
    if len(raw) > MAX_AUDIO_BYTES:
        raise OpenAICompatError(
            f"音频过大（{len(raw) / 1024 / 1024:.1f}MB > {MAX_AUDIO_BYTES / 1024 / 1024:.0f}MB）："
            "请换本地 faster-whisper 或由任务路径自动分片"
        )
    data_url = f"data:{_mime_for(audio_path)};base64,{base64.b64encode(raw).decode('ascii')}"
    body = {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "input_audio", "input_audio": {"data": data_url}}],
                }
            ]
        },
        "parameters": {"format": "wav", "sample_rate": "16000"},
    }
    headers = {"X-DashScope-SSE": "disable"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    async with make_client(endpoint_url) as client:
        try:
            r = await client.post(full_url(endpoint_url, api_path), json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"连接云端失败（{endpoint_url}）：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端返回 {r.status_code}：{r.text[:300]}")
    try:
        sentence = r.json()["sentence"]
        text = str(sentence.get("text", "")).strip()
        words = [
            {"w": str(w.get("text", "")).strip(), "s": w.get("begin_time", 0) / 1000,
             "e": w.get("end_time", 0) / 1000}
            for w in sentence.get("words", [])
            if str(w.get("text", "")).strip()
        ]
    except (ValueError, KeyError, TypeError) as exc:
        raise OpenAICompatError(f"云端响应结构异常：{r.text[:300]}") from exc
    return {"text": text, "words": words}


async def transcribe_long(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    audio_path: str,
    *,
    api_path: str,
    on_progress=None,
) -> dict:
    """阿里云原生 STT 长音频入口：≤MAX_AUDIO_BYTES 直发，超限切 60s wav 分片转写拼接

    分片逻辑与 MAX_AUDIO_BYTES 同文件维护（此前分片在 API 层、阈值常量与
    此处脱钩——平台限制一变分片长度就静默过期）。每片带词级时间戳（相对
    分片起点），拼接时按分片起点平移 → 整段词级时间轴；分片临时文件用后即删。

    Args:
        on_progress: 进度回调（(0~1, 说明文案)；直发即 0.5）
    Returns:
        {"text": 全文, "words": [{w,s,e}, …]}（时间轴为整段绝对秒）
    Raises:
        OpenAICompatError: 网络/HTTP/响应结构/无法探测时长
    """
    size = Path(audio_path).stat().st_size
    if size <= MAX_AUDIO_BYTES:
        if on_progress:
            on_progress(0.5, "云端转写中")
        return await transcribe(endpoint_url, api_key, model, audio_path, api_path=api_path)

    from ..media import ffmpeg  # noqa: PLC0415

    texts: list[str] = []
    words: list[dict] = []
    work: Path | None = None
    try:
        duration_ms = int((await asyncio.to_thread(ffmpeg.probe, audio_path)).get("duration_ms") or 0)
        if duration_ms <= 0:
            raise OpenAICompatError("无法探测音频时长，分片转写中止")
        # 分片时长由体积上限推得：16kHz mono wav ≈ 32KB/s，60s ≈ 1.9MB（base64 后
        # 仍稳在 MAX_AUDIO_BYTES 内；上限若调整，按 32KB/s 重新核算）
        chunk_ms = 60_000
        total = math.ceil(duration_ms / chunk_ms)
        work = Path(audio_path).parent / ".stt-chunks"
        work.mkdir(parents=True, exist_ok=True)
        for i in range(total):
            start, end = i * chunk_ms, min((i + 1) * chunk_ms, duration_ms)
            chunk = str(work / f"{i:04d}.wav")
            await asyncio.to_thread(ffmpeg.slice_audio, audio_path, start, end, chunk)
            try:
                piece = await transcribe(endpoint_url, api_key, model, chunk, api_path=api_path)
            finally:
                Path(chunk).unlink(missing_ok=True)
            if piece["text"]:
                texts.append(piece["text"])
            # 分片内词时间戳（相对分片）平移到整段时间轴
            for w in piece["words"]:
                words.append({"w": w["w"], "s": w["s"] + start / 1000, "e": w["e"] + start / 1000})
            if on_progress:
                on_progress(0.05 + 0.9 * (i + 1) / total, f"云端分片转写 {i + 1}/{total}")
    except ffmpeg.MediaError as exc:
        # 探测/切片属本地媒体处理失败（ffmpeg 缺失/源损坏），包装为本模块异常
        raise OpenAICompatError(f"音频分片处理失败：{exc}") from exc
    finally:
        # 分片目录不残留（含 slice 中途失败留下的半截片）
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)
    return {"text": " ".join(texts), "words": words}


async def synthesize(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    text: str,
    *,
    voice: str | None = None,
) -> bytes:
    """云端语音合成（WebSocket 实时协议）：文本 → mp3 字节（带缓存）

    建连/限时收发与传输层异常归一走共享 WsSession（与腾讯云 SOE 同一脚手架）。

    Args:
        model:    模型名（如 qwen-audio-3.0-tts-plus；空串兜底默认）
        text:     待合成文本（web 侧已限长）
        voice:    音色（如 longanlingxin；None=默认音色）
    Raises:
        OpenAICompatError: 网络/鉴权/任务失败/空音频
    """
    text = text.strip()
    if not text:
        raise OpenAICompatError("待合成文本为空")
    if not api_key:
        raise OpenAICompatError("云端 TTS 需要 API Key")
    model = model or DEFAULT_TTS_MODEL
    voice = voice or DEFAULT_TTS_VOICE

    from ..engines.tts_common import write_atomic  # noqa: PLC0415

    cache = cache_path(text, model, voice, endpoint_url)
    if cache.is_file():
        return cache.read_bytes()

    url = ws_url(endpoint_url)
    run_task = {
        "header": {
            "message_id": str(uuid.uuid4()),
            "task_id": str(uuid.uuid4()),
            "action": "run-task",
            "streaming": "out",
        },
        "payload": {
            "model": model,
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "input": {"text": text},
            "parameters": {"voice": voice, "format": "mp3", "sample_rate": TTS_SAMPLE_RATE},
        },
    }
    audio = bytearray()
    async with WsSession(
        url,
        error=OpenAICompatError,
        label="云端合成",
        open_timeout=15,
        recv_timeout=120,
        headers={"Authorization": f"bearer {api_key}"},
    ) as ws:
        await ws.send(json.dumps(run_task))
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                audio.extend(msg)
                continue
            event = json.loads(msg).get("header", {}).get("event")
            if event == "task-failed":
                detail = json.loads(msg).get("header", {}).get("error_message", "")
                raise OpenAICompatError(f"云端合成失败：{detail[:200]}")
            if event in ("task-finished", "task-canceled"):
                break

    if not audio:
        raise OpenAICompatError("云端返回空音频")
    data = bytes(audio)
    write_atomic(cache, data)
    return data


async def ensure_synthesized(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    text: str,
    *,
    voice: str | None = None,
) -> Path:
    """确保合成产物已在缓存就位并返回其路径（缓存命中时不读回字节）

    与 tts_kokoro.ensure_synthesized 同契约：产物交给 web 代理单次读取、
    size 由调用方 stat——云端 /tts 路径此前为拿 size 把整段 mp3 读回引擎
    内存，web 代理还要再读一遍文件。
    """
    cache = cache_path(text, model or DEFAULT_TTS_MODEL, voice or DEFAULT_TTS_VOICE, endpoint_url)
    if not cache.is_file():
        await synthesize(endpoint_url, api_key, model, text, voice=voice)
    return cache
