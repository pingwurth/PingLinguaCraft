"""
ffmpeg/ffprobe 媒体工具：探测、音频抽取、静音生成、拼接、波形峰值

全部走本机 ffmpeg 子进程（同步阻塞，调用方放线程池）。
"""

import json
import subprocess
from pathlib import Path


class MediaError(RuntimeError):
    """媒体处理失败（ffmpeg 缺失/文件异常/返回非零）"""


def _run(cmd: list[str], *, timeout: float = 600.0) -> subprocess.CompletedProcess:
    """执行子进程：非零退出码抛 MediaError（stdout/stderr 附在错误信息里）"""
    try:
        r = subprocess.run(  # noqa: S603 —— 命令为固定参数列表，无 shell
            cmd, capture_output=True, text=True, timeout=timeout
        )
    except FileNotFoundError as exc:
        raise MediaError("未找到 ffmpeg/ffprobe，请先安装") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaError(f"媒体处理超时：{' '.join(cmd[:3])} …") from exc
    if r.returncode != 0:
        raise MediaError(f"命令失败（{cmd[0]}）：{r.stderr[-500:]}")
    return r


def probe(path: str) -> dict:
    """探测媒体元数据

    Returns:
        {duration_ms, size_bytes, mime, width?, height?}（width/height 仅视频有）
    """
    r = _run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", path,
        ]
    )
    try:
        data = json.loads(r.stdout)
    except ValueError as exc:
        raise MediaError("ffprobe 输出无法解析") from exc
    fmt = data.get("format", {})
    duration_ms = round(float(fmt.get("duration", 0)) * 1000)
    # 从流里找视频分辨率与编解码 mime
    width = height = None
    mime = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video" and width is None:
            width, height = stream.get("width"), stream.get("height")
            mime = f"video/{stream.get('codec_name', 'mp4')}"
        elif stream.get("codec_type") == "audio" and mime is None:
            mime = f"audio/{stream.get('codec_name', 'mp3')}"
    return {
        "duration_ms": duration_ms,
        "size_bytes": int(fmt.get("size") or Path(path).stat().st_size),
        "mime": mime,
        "width": width,
        "height": height,
    }


def audio_duration_ms(path: str) -> int:
    """测音频时长（毫秒）"""
    r = _run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "json", path,
        ]
    )
    try:
        return round(float(json.loads(r.stdout)["format"]["duration"]) * 1000)
    except (ValueError, KeyError) as exc:
        raise MediaError("时长解析失败") from exc


def extract_audio(source: str, out_wav: str) -> str:
    """抽取 16kHz 单声道 wav（STT 标准输入；faster-whisper 也接受原视频，
    但显式抽wav可让「重听单句切片」等场景复用同一文件）"""
    _run(
        [
            "ffmpeg", "-y", "-i", source,
            "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", out_wav,
        ]
    )
    return out_wav


def slice_audio(source: str, start_ms: int, end_ms: str | int, out_path: str) -> str:
    """按时间切片（单句重 STT 用）：-ss 前置快速定位"""
    _run(
        [
            "ffmpeg", "-y", "-ss", f"{start_ms / 1000:.3f}",
            "-to", f"{int(end_ms) / 1000:.3f}",
            "-i", source, "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", out_path,
        ]
    )
    return out_path


def make_silence(seconds: float, out_path: str) -> str:
    """生成指定时长的静音 mp3（24kHz 单声道，与 edge-tts 输出参数一致）"""
    _run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
            "-t", f"{seconds:.2f}", "-b:a", "48k", out_path,
        ]
    )
    return out_path


def concat_audio(parts: list[str], out_path: str) -> str:
    """拼接音频片段列表 → 单文件（统一重编码 mp3 24kHz 单声道，确定性输出）"""
    if not parts:
        raise MediaError("拼接列表为空")
    # concat 拼接器需要 list 文件；路径简单转义单引号
    list_path = Path(out_path).parent / ".concat-list.txt"
    list_path.write_text(
        "\n".join(f"file '{p}'" for p in parts), encoding="utf-8"
    )
    try:
        _run(
            [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", str(list_path),
                "-ar", "24000", "-ac", "1", "-b:a", "48k",
                out_path,
            ]
        )
    finally:
        list_path.unlink(missing_ok=True)
    return out_path


def peaks(path: str, buckets: int = 2000) -> list[float]:
    """计算波形峰值（0~1 归一化绝对幅度，供播放页 canvas 波形渲染）

    解码为 8kHz 单声道 s16le 原始流，按桶取绝对最大值。
    """
    if buckets <= 0:
        raise MediaError("buckets 必须为正")
    r = subprocess.run(  # noqa: S603
        [
            "ffmpeg", "-v", "error", "-i", path,
            "-f", "s16le", "-ac", "1", "-ar", "8000", "-",
        ],
        capture_output=True,
        timeout=600,
    )
    if r.returncode != 0:
        raise MediaError(f"峰值解码失败：{r.stderr[-300:]!r}")
    import array

    samples = array.array("h")
    samples.frombytes(r.stdout)
    n = len(samples)
    if n == 0:
        return [0.0] * buckets
    out: list[float] = []
    step = n / buckets
    for i in range(buckets):
        lo = int(i * step)
        hi = max(lo + 1, int((i + 1) * step))
        peak = max(abs(samples[j]) for j in range(lo, min(hi, n)))
        out.append(round(peak / 32768.0, 4))
    return out
