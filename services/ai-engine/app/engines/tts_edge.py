"""
Edge-TTS 引擎（联网微软语音，免费、有标准英音声部）

- 单次合成：text → mp3 字节（内容哈希缓存，点词朗读等高频短文本零重复成本）
- 批量合成（文本导入）：逐句合成 → 测长 → 0.35s 静音间隔 → ffmpeg 拼接成整卷音频，
  返回每句起止毫秒（web 端回填 cues 时间轴）
- 默认音色 en-GB-GeorgeNeural（男声英音）； SoniaNeural 为女声英音备选
"""

import asyncio
from pathlib import Path

from .tts_common import SENTENCE_GAP_SEC, assemble_timeline, new_batch_workdir, tts_cache_path, write_atomic

# 默认英音声部（需求 8：点词朗读默认英音）
# 注意：en-GB-GeorgeNeural 已被微软下架（NoAudioReceived），现行英音男声为 Ryan
DEFAULT_VOICE = "en-GB-RyanNeural"
# 带展示标签的音色清单（/tts/voices 端点 → web 设置页下拉用；清单只存在这一份）
VOICE_OPTIONS = [
    {"value": "en-GB-RyanNeural", "label": "Ryan · 英音男声 · 沉稳"},
    {"value": "en-GB-ThomasNeural", "label": "Thomas · 英音男声 · 明快"},
    {"value": "en-GB-SoniaNeural", "label": "Sonia · 英音女声 · 标准"},
    {"value": "en-GB-LibbyNeural", "label": "Libby · 英音女声 · 柔和"},
    {"value": "en-GB-MaisieNeural", "label": "Maisie · 英音女声 · 少年"},
]


class TTSEngineError(RuntimeError):
    """TTS 合成失败（依赖缺失/网络/拼接异常）"""


def cache_path(text: str, voice: str, rate: str) -> Path:
    """计算缓存文件路径（"voice|rate|text" 的 sha256 → mp3）

    text 先 strip——与 synthesize 的清洗一致（调用方传原始文本也命中同一路径）；
    哈希与落位走 tts_common.tts_cache_path 单一实现（三路合成共用）。
    """
    return tts_cache_path(f"{voice}|{rate}|{text.strip()}", "mp3")


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

    cache = cache_path(text, voice, rate)
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
    write_atomic(cache, data)
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

    逐句并发合成 mp3 分片，拼装（测长 → 静音间隔 → concat 重编码 → 清理）
    走 tts_common.assemble_timeline，与 kokoro 路径共享同一句边界语义。
    Returns:
        每句时间轴 [{startMs, endMs}, ...]（含句间静音间隔）
    Raises:
        TTSEngineError: 任一句失败或拼接失败
    """
    if not sentences:
        raise TTSEngineError("句子列表为空")

    out_dir = Path(out_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    # 唯一分片目录：同步 /tts/batch 与 tts_batch 任务可能并发落在同一 out_dir，
    # 固定名 .tts-parts 会互踩（详见 tts_common.new_batch_workdir）
    work = new_batch_workdir(out_path)

    # 逐句合成（并发度 4：edge-tts 服务端限流友好）
    sem = asyncio.Semaphore(4)

    async def one(i: int, text: str) -> tuple[int, str]:
        """单句合成落分片（信号量内执行），返回 (句序, 分片路径)"""
        async with sem:
            data = await synthesize(text, voice=voice, rate=rate)
            p = work / f"{i:05d}.mp3"
            p.write_bytes(data)
            if on_progress:
                on_progress((i + 1) / (len(sentences) + 1))
            return i, str(p)

    results = await asyncio.gather(*(one(i, s) for i, s in enumerate(sentences)))
    parts = [p for _, p in sorted(results)]

    # mp3 分片时长只能 ffprobe 探测（拼装细节见 tts_common.assemble_timeline）
    return assemble_timeline(parts, out_path, gap_sec=gap_sec, on_progress=on_progress)
