"""
Edge-TTS 引擎（联网微软语音，免费、有标准英音声部）

- 单次合成：text → mp3 字节（内容哈希缓存，点词朗读等高频短文本零重复成本）
- 批量合成（文本导入）：逐句合成 → 测长 → 0.35s 静音间隔 → ffmpeg 拼接成整卷音频，
  返回每句起止毫秒（web 端回填 cues 时间轴）
- 默认音色 en-GB-GeorgeNeural（男声英音）； SoniaNeural 为女声英音备选
"""

import asyncio
import hashlib
from pathlib import Path

from .. import settings
from ..media import ffmpeg

# 默认英音声部（需求 8：点词朗读默认英音）
# 注意：en-GB-GeorgeNeural 已被微软下架（NoAudioReceived），现行英音男声为 Ryan
DEFAULT_VOICE = "en-GB-RyanNeural"
# 现行可选英音声部（web 端设置页下拉用）
EN_GB_VOICES = [
    "en-GB-RyanNeural",     # 男声·沉稳
    "en-GB-ThomasNeural",   # 男声·明快
    "en-GB-SoniaNeural",    # 女声·标准
    "en-GB-LibbyNeural",    # 女声·柔和
    "en-GB-MaisieNeural",   # 女声·少年
]
# 批量合成的句间静音间隔（秒）：保证句边界清晰、时间轴可回填
SENTENCE_GAP_SEC = 0.35

# 内容哈希缓存目录：~/.pinglc/caches/tts/
_TTS_CACHE_DIR = Path(settings.CACHES_DIR) / "tts"


class TTSEngineError(RuntimeError):
    """TTS 合成失败（依赖缺失/网络/拼接异常）"""


def _cache_path(text: str, voice: str, rate: str) -> Path:
    """计算缓存文件路径（text+voice+rate 的 sha256）"""
    key = hashlib.sha256(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()
    _TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _TTS_CACHE_DIR / f"{key}.mp3"


async def synthesize(
    text: str,
    *,
    voice: str = DEFAULT_VOICE,
    rate: str = "+0%",
) -> bytes:
    """单次合成（带缓存）：文本 → mp3 字节

    Args:
        text:  待合成文本（词或句）
        voice: edge-tts 音色全名（如 en-GB-SoniaNeural）
        rate:  语速调整（如 "-10%" / "+20%"）
    Raises:
        TTSEngineError: edge-tts 未安装或网络失败
    """
    text = text.strip()
    if not text:
        raise TTSEngineError("待合成文本为空")

    cache = _cache_path(text, voice, rate)
    if cache.is_file():
        return cache.read_bytes()

    try:
        import edge_tts  # noqa: PLC0415
    except ImportError as exc:
        raise TTSEngineError(
            "edge-tts 未安装：运行 ./scripts/engine-setup.sh 安装 tts 层"
        ) from exc

    communicate = edge_tts.Communicate(text, voice, rate=rate)
    chunks: list[bytes] = []
    try:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
    except Exception as exc:  # noqa: BLE001
        raise TTSEngineError(f"edge-tts 合成失败：{exc}") from exc
    if not chunks:
        raise TTSEngineError("edge-tts 未返回音频（网络异常或文本被过滤）")
    data = b"".join(chunks)
    cache.write_bytes(data)
    return data


async def synthesize_batch(
    sentences: list[str],
    out_path: str,
    *,
    voice: str = DEFAULT_VOICE,
    rate: str = "+0%",
    gap_sec: float = SENTENCE_GAP_SEC,
    on_progress=None,
) -> list[dict]:
    """批量合成整卷音频（文本导入主路径）

    逐句合成 mp3 → ffprobe 测长 → 生成静音文件 → ffmpeg concat 拼接 → out_path。
    Returns:
        每句时间轴 [{startMs, endMs}, ...]（含句间静音间隔）
    Raises:
        TTSEngineError: 任一句失败或拼接失败
    """
    if not sentences:
        raise TTSEngineError("句子列表为空")

    out_dir = Path(out_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / ".tts-parts"
    work.mkdir(exist_ok=True)

    # 逐句合成（并发度 4：edge-tts 服务端限流友好）
    sem = asyncio.Semaphore(4)

    async def one(i: int, text: str) -> tuple[int, str]:
        async with sem:
            data = await synthesize(text, voice=voice, rate=rate)
            p = work / f"{i:05d}.mp3"
            p.write_bytes(data)
            if on_progress:
                on_progress((i + 1) / (len(sentences) + 1))
            return i, str(p)

    try:
        results = await asyncio.gather(*(one(i, s) for i, s in enumerate(sentences)))
    except TTSEngineError:
        raise
    finally:
        pass
    parts = [p for _, p in sorted(results)]

    # 逐句测长，生成静音间隔文件，计算时间轴
    gap_ms = round(gap_sec * 1000)
    silence = str(work / "silence.mp3")
    ffmpeg.make_silence(gap_sec, silence)
    timeline: list[dict] = []
    cursor = 0
    concat_items: list[str] = []
    for idx, part in enumerate(parts):
        dur_ms = ffmpeg.audio_duration_ms(part)
        timeline.append({"startMs": cursor, "endMs": cursor + dur_ms})
        concat_items.append(part)
        cursor += dur_ms
        if idx < len(parts) - 1:
            concat_items.append(silence)
            cursor += gap_ms

    # 拼接（统一重编码为 mp3，规避参数不一致的 concat 失败）
    ffmpeg.concat_audio(concat_items, out_path)
    # 清理分片目录
    for f in work.iterdir():
        f.unlink(missing_ok=True)
    work.rmdir()
    if on_progress:
        on_progress(1.0)
    return timeline
