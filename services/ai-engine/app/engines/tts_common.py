"""
TTS 三路合成（edge 联网 / kokoro 离线 / 阿里云原生 WebSocket）共用逻辑

- write_atomic：合成缓存的原子落盘（与模型下载同一纪律：.part + os.replace，
  中断不留「看似完整」的半截文件骗过后续缓存命中；临时名带随机后缀，
  同键并发写互不截断）；
- tts_cache_path：内容哈希缓存路径的单一构造器（三路合成的键都经此处
  落位 ~/.pinglc/caches/tts/，strip/建目录纪律只存一份）；
- assemble_timeline：批量合成的拼装主路径（逐句测长 → 静音间隔 → ffmpeg 拼接
  → 清理分片），edge 与 kokoro 的 synthesize_batch 在此共享同一实现，
  句边界语义永远一致（此前两份逐字拷贝，调一处漏一处）。
"""

import hashlib
import os
import uuid
from pathlib import Path
from typing import Callable

from ..media import ffmpeg

# 批量合成的句间静音间隔（秒）：保证句边界清晰、时间轴可回填（双引擎同值）
SENTENCE_GAP_SEC = 0.35


def write_atomic(path: Path, data: bytes) -> None:
    """原子写文件：先写同目录「随机后缀 .part」临时文件再 os.replace 改名

    临时名带 uuid——两个线程并发合成同一文本（如 /tts 点读与 tts_batch 任务
    撞同一缓存键）时各写各的 .part，交错写不会互相截断，os.replace 后落位
    者必完整；固定 .part 名的旧实现里并发写会互相覆盖半截文件并把损坏产物
    永久钉进内容哈希缓存（无驱逐/自愈路径）。失败时 finally 清理残骸
    （随机名残骸不会像固定名那样被下次覆盖，必须显式删）。
    """
    part = path.with_name(f"{path.name}.{uuid.uuid4().hex}.part")
    try:
        part.write_bytes(data)
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)  # 改名成功后已不存在，missing_ok 容忍


def tts_cache_path(key: str, ext: str) -> Path:
    """TTS 合成缓存路径（sha256(key) → ~/.pinglc/caches/tts/<hash>.<ext>）

    键字符串由调用方拼（含引擎前缀与字段分隔：edge 无前缀 / kokoro| /
    cloud|model|voice|host），strip 纪律也归调用方；此处只负责哈希、建目录、
    落位——此前 edge/kokoro/阿里云三处各持一份 mkdir+sha256 拷贝，改一处
    漏两处即缓存键静默漂移（全量 miss 或互相污染）。
    """
    from .. import settings  # noqa: PLC0415 —— 惰性导入 settings，与旧实现同策略（测试隔离）

    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    cache_dir = Path(settings.CACHES_DIR) / "tts"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / f"{digest}.{ext}"


def assemble_timeline(
    parts: list[str],
    out_path: str,
    *,
    gap_sec: float = SENTENCE_GAP_SEC,
    part_durations_ms: list[int] | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> list[dict]:
    """拼装整卷音频与每句时间轴（edge / kokoro 批量合成共用）

    Args:
        parts:             分片文件路径（按句序，全部同容器同编码）
        out_path:          整卷输出路径（concat 统一重编码 mp3）
        gap_sec:           句间静音秒数
        part_durations_ms: 每片时长（毫秒）；提供时省去逐片 ffprobe 子进程
                           （wav 分片可由字节算术求得，mp3 只能探测）
        on_progress:       收尾进度回调（拼装完成时回调 1.0）
    Returns:
        每句时间轴 [{startMs, endMs}, ...]（含句间静音间隔）
    Raises:
        ffmpeg.MediaError: 静音生成 / 时长探测 / 拼接失败
    """
    gap_ms = round(gap_sec * 1000)
    # 静音片段与分片同容器（concat demuxer 要求全片段同参数；扩展名推断编码）
    work = Path(parts[0]).parent
    silence = str(work / f"silence{Path(parts[0]).suffix}")
    ffmpeg.make_silence(gap_sec, silence)

    timeline: list[dict] = []
    cursor = 0
    concat_items: list[str] = []
    for idx, part in enumerate(parts):
        dur_ms = part_durations_ms[idx] if part_durations_ms else ffmpeg.audio_duration_ms(part)
        timeline.append({"startMs": cursor, "endMs": cursor + dur_ms})
        concat_items.append(part)
        cursor += dur_ms
        if idx < len(parts) - 1:
            concat_items.append(silence)
            cursor += gap_ms

    ffmpeg.concat_audio(concat_items, out_path)
    # 清理分片目录（含静音片段）
    for f in work.iterdir():
        f.unlink(missing_ok=True)
    work.rmdir()
    if on_progress:
        on_progress(1.0)
    return timeline
