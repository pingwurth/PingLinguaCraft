"""
TTS 双引擎（edge 联网 / kokoro 离线）共用逻辑

- write_atomic：合成缓存的原子落盘（与模型下载同一纪律：.part + os.replace，
  中断不留「看似完整」的半截文件骗过后续缓存命中）；
- assemble_timeline：批量合成的拼装主路径（逐句测长 → 静音间隔 → ffmpeg 拼接
  → 清理分片），edge 与 kokoro 的 synthesize_batch 在此共享同一实现，
  句边界语义永远一致（此前两份逐字拷贝，调一处漏一处）。
"""

import os
from pathlib import Path
from typing import Callable

from ..media import ffmpeg

# 批量合成的句间静音间隔（秒）：保证句边界清晰、时间轴可回填（双引擎同值）
SENTENCE_GAP_SEC = 0.35


def write_atomic(path: Path, data: bytes) -> None:
    """原子写文件：先写同目录 .part 临时文件再 os.replace 改名

    崩溃/断电最多留下 .part 残骸（下次重算键时被覆盖），目标路径要么
    完整、要么不存在——缓存 is_file() 命中即完整。
    """
    part = path.with_name(path.name + ".part")
    part.write_bytes(data)
    os.replace(part, path)


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
