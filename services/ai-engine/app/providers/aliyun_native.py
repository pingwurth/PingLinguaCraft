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
import hashlib
import json
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx
import websockets

from .openai_compat import OpenAICompatError, make_client

# 单次内嵌音频的体积上限（base64 前的原始字节）：平台限制 10MB，留余量
MAX_AUDIO_BYTES = 8 * 1024 * 1024

# 默认模型与音色（设置页模型/音色留空时的兜底；音色清单见千问平台 Qwen-Audio-TTS 页）
DEFAULT_STT_MODEL = "qwen-audio-3.0-asr-flash"
DEFAULT_TTS_MODEL = "qwen-audio-3.0-tts-plus"
DEFAULT_TTS_VOICE = "longanlingxin"

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


def cache_path(text: str, model: str, voice: str) -> Path:
    """云端 TTS 合成缓存路径（text+model+voice 的 sha256；cloud| 前缀与本地引擎键空间隔离）"""
    from .. import settings  # noqa: PLC0415 —— 与 tts_edge 同策略，惰性导入便于测试隔离

    key = hashlib.sha256(f"cloud|{model}|{voice}|{text.strip()}".encode("utf-8")).hexdigest()
    cache_dir = Path(settings.CACHES_DIR) / "tts"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{key}.mp3"


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


async def synthesize(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    text: str,
    *,
    api_path: str | None = None,  # noqa: ARG001 —— TTS 走 WebSocket，apiPath 不参与（签名与 STT 对齐）
    voice: str | None = None,
) -> bytes:
    """云端语音合成（WebSocket 实时协议）：文本 → mp3 字节（带缓存）

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

    cache = cache_path(text, model, voice)
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
    try:
        async with websockets.connect(
            url, max_size=MAX_AUDIO_BYTES, open_timeout=15,
            additional_headers={"Authorization": f"bearer {api_key}"},
        ) as ws:
            await ws.send(json.dumps(run_task))
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=120)
                if isinstance(msg, bytes):
                    audio.extend(msg)
                    continue
                event = json.loads(msg).get("header", {}).get("event")
                if event == "task-failed":
                    detail = json.loads(msg).get("header", {}).get("error_message", "")
                    raise OpenAICompatError(f"云端合成失败：{detail[:200]}")
                if event in ("task-finished", "task-canceled"):
                    break
    except OpenAICompatError:
        raise
    except asyncio.TimeoutError as exc:
        raise OpenAICompatError("云端合成超时") from exc
    except (websockets.WebSocketException, OSError) as exc:
        raise OpenAICompatError(f"WebSocket 连接失败（{url}）：{exc}") from exc

    if not audio:
        raise OpenAICompatError("云端返回空音频")
    data = bytes(audio)
    write_atomic(cache, data)
    return data
