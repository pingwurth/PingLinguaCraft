"""
yt-dlp 链接导入：YouTube / Bilibili / TED / RSS 音视频下载

以 Python 模块方式进程内调用（同步阻塞，调用方放线程池）。
策略：
- 视频 ≤1080p mp4（bv*+ba 合并）；纯音频源退化为 bestaudio
- 顺带抓英文字幕（人工字幕优先，自动字幕兜底）—— 有官方字幕则免 STT
- 输出固定文件名 media.{ext}，元数据 info.json，字幕 *.en*.{vtt|srt}
"""

from pathlib import Path


class DownloadError(RuntimeError):
    """链接下载失败（站点限制/格式缺失/yt-dlp 异常）"""


def download(
    url: str,
    out_dir: str,
    *,
    want_video: bool = True,
    on_progress=None,
) -> dict:
    """下载链接内容到 out_dir

    Args:
        url:        原始链接（YouTube/Bilibili/TED/RSS 任意 yt-dlp 支持源）
        out_dir:    输出目录（由 web 端创建于 ~/.pinglc/media/…）
        want_video: True 优先视频；False 只要音频（播客/RSS 场景）
        on_progress: 进度回调（0~1）
    Returns:
        {media_path, info, subtitle_path}（subtitle_path 无字幕时为 None）
    Raises:
        DownloadError: yt-dlp 不可用或下载失败
    """
    try:
        import yt_dlp  # noqa: PLC0415
    except ImportError as exc:
        raise DownloadError(
            "yt-dlp 未安装：运行 ./scripts/engine-setup.sh 后在引擎目录 uv sync"
        ) from exc

    Path(out_dir).mkdir(parents=True, exist_ok=True)

    fmt = (
        "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*+ba/b"
        if want_video
        else "ba/b"
    )

    def _hook(d):
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                on_progress(min(0.99, d.get("downloaded_bytes", 0) / total))
        elif on_progress and d.get("status") == "finished":
            on_progress(0.99)

    opts = {
        "format": fmt,
        "outtmpl": f"{out_dir}/media.%(ext)s",
        "merge_output_format": "mp4",
        "writeinfojson": True,
        "noplaylist": True,           # 只取单条（播放列表在 web 层让用户逐条导入）
        "writesubtitles": True,        # 人工字幕
        "writeautomaticsub": True,     # 自动字幕兜底
        "subtitleslangs": ["en", "en-GB", "en-US", "en.*"],
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [_hook],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:  # noqa: BLE001 —— yt-dlp 异常类型庞杂，统一包装
        raise DownloadError(f"下载失败：{exc}") from exc

    if info is None:
        raise DownloadError("yt-dlp 未返回信息")

    # 定位下载产物：同目录下 media.*（排除字幕与 info.json）
    media_path = None
    for f in sorted(Path(out_dir).glob("media.*")):
        if f.suffix in {".mp4", ".mkv", ".webm", ".m4a", ".mp3", ".opus", ".ogg", ".wav"}:
            media_path = str(f)
            break
    if media_path is None:
        raise DownloadError("下载完成但未找到媒体文件（站点可能仅提供不支持的格式）")

    # 定位字幕文件（en 开头，vtt/srt；排除 info.json）
    subtitle_path = None
    subs = sorted(
        [f for f in Path(out_dir).glob("media.en*.*") if f.suffix in {".vtt", ".srt"}]
    )
    if subs:
        subtitle_path = str(subs[0])

    if on_progress:
        on_progress(1.0)
    # info 里只保留 web 需要的字段（原 info 很大）
    slim_info = {
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration_ms": round((info.get("duration") or 0) * 1000),
        "webpage_url": info.get("webpage_url") or url,
        "extractor": info.get("extractor_key"),
        "description": (info.get("description") or "")[:2000],
    }
    return {"media_path": media_path, "info": slim_info, "subtitle_path": subtitle_path}
