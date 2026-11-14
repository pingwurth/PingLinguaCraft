"""
系统能力路由：健康检查 / 能力探测 / 配置读写

/system/capabilities 探测本地各引擎的真实可用性（import 成功 + 模型/镜像存在），
web 端据此渲染 STT/TTS/对齐的下拉选项（不可用的引擎灰显）。

探测可能阻塞数秒（CUDA 库冷导入 / docker 子进程），因此：
- capabilities 端点声明为同步 def：FastAPI 自动放线程池执行，不冻结事件循环
  （事件循环上的 JobRunner worker 与 /jobs 轮询不受影响）；配置读写端点同策略
- 模块与 docker 镜像探测只缓存肯定结果——否定恰恰是可被在线修复的状态
  （engine-setup.sh 装依赖 / docker 构建镜像都不重启引擎），永久缓存否定会
  在修复后仍谎报不可用；GPU 探测例外（硬件在进程生命周期内不变，全量缓存）
"""

import importlib.util
import shutil
import subprocess
from functools import lru_cache

from fastapi import APIRouter

from .. import settings

router = APIRouter()


# 已确认可导入的模块集合：与 docker 探测同策略，只缓存肯定结果——
# 模块缺失恰恰是可被在线修复的状态（engine-setup.sh 的 uv sync 不重启引擎），
# 永久缓存否定会让装好依赖后 UI 仍灰显，直到手动重启
_cached_modules: set[str] = set()


def _probe_module(module: str) -> bool:
    """探测 Python 模块是否可导入（不实际加载，轻量）；肯定结果进程内缓存

    否定时每次重探（find_spec 对缺失模块的路径扫描开销毫秒级，capabilities 调用频率低）。
    """
    if module in _cached_modules:
        return True
    if importlib.util.find_spec(module) is not None:
        _cached_modules.add(module)
        return True
    return False


# 已确认拉取的 Docker 镜像集合：只缓存肯定结果（镜像在进程生命周期内不会消失），
# 否定结果不缓存——dockerd 未就绪 / 探测超时 / 镜像稍后才构建都会误报不可用，
# 永久缓存会让 MFA 整个进程周期显示不可用，与「能力探测绝不谎报」相悖
_cached_docker_images: set[str] = set()


def _probe_docker_image(image: str) -> bool:
    """探测 Docker 镜像是否已拉取（MFA 走 Docker 方案）；肯定结果进程内缓存

    否定时每次重探（子进程开销 ~百毫秒级，capabilities 端点调用频率低，可接受）。
    """
    if image in _cached_docker_images:
        return True
    if shutil.which("docker") is None:
        return False
    try:
        r = subprocess.run(  # noqa: S603 —— 固定镜像名，无注入面
            ["docker", "image", "inspect", image],
            capture_output=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    if r.returncode == 0:
        _cached_docker_images.add(image)
        return True
    return False


@lru_cache(maxsize=None)
def _probe_cuda() -> bool:
    """探测 CUDA 可用性（优先 ctranslate2，回退 torch）；结果进程内缓存"""
    try:
        import ctranslate2  # noqa: PLC0415 —— 惰性导入避免无 GPU 环境报错

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        try:
            import torch  # noqa: PLC0415

            return torch.cuda.is_available()
        except Exception:  # noqa: BLE001
            return False


@router.get("/health")
async def health() -> dict:
    """存活检查：进程存活即健康（web 端启动时探活）"""
    return {"status": "ok", "service": "pinglc-ai-engine"}


@router.get("/system/capabilities")
def capabilities() -> dict:
    """能力探测：各本地引擎可用性 + GPU 状态（驱动 UI 下拉与降级提示）

    同步端点（非 async def）：FastAPI 自动放入线程池执行，
    阻塞探测（CUDA 冷导入 / docker 子进程 / 守护进程卡死）不会冻结事件循环。
    """
    return {
        # STT：faster-whisper（默认路径）与 whisperx（可选 extra）
        "stt": {
            "faster_whisper": _probe_module("faster_whisper"),
            "whisperx": _probe_module("whisperx"),
        },
        # TTS：edge-tts（联网）与 kokoro（本地离线）
        "tts": {
            "edge_tts": _probe_module("edge_tts"),
            "kokoro": _probe_module("kokoro_onnx"),
        },
        # 音素对齐：whisperx（上）与 MFA（Docker 镜像存在性）
        "align": {
            "whisperx": _probe_module("whisperx"),
            "mfa_docker": _probe_docker_image("pinglc-mfa:latest"),
        },
        # GPU
        "cuda": _probe_cuda(),
        # yt-dlp（链接导入）：PATH 可执行文件或 Python 模块（uv extras 安装的常态）任一即可
        "yt_dlp": shutil.which("yt-dlp") is not None or _probe_module("yt_dlp"),
        # ffmpeg（音频抽取/拼接）
        "ffmpeg": shutil.which("ffmpeg") is not None,
    }


@router.get("/system/config")
def read_config() -> dict:
    """读取引擎运行时配置（~/.pinglc/config.json）

    同步端点（非 async def）：load_config 含文件读 + 缺失时的落盘写（阻塞 I/O），
    FastAPI 自动放线程池执行，慢盘不会冻结事件循环（JobRunner 与 /jobs 轮询不受影响）。
    """
    return settings.load_config()


@router.put("/system/config")
def write_config(config: dict) -> dict:
    """合并式更新引擎运行时配置：只改传入的键，其余键保留现值/默认值

    同步端点（非 async def）：save_config 的临时文件写入 + os.replace 为阻塞磁盘 I/O，
    放线程池执行避免慢盘拖住事件循环（与 capabilities 端点同一策略）。
    """
    merged = settings.save_config(config)
    return {"saved": True, "config": merged}
