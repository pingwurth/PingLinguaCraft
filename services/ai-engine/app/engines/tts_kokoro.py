"""
kokoro 本地离线 TTS 引擎（kokoro-onnx 封装）

kokoro 相关的模型、音色、配套文件统一落在 ~/.pinglc/models/kokoro/ 下：
  ~/.pinglc/models/kokoro/kokoro-v1.0.onnx   模型权重（~310MB）
  ~/.pinglc/models/kokoro/voices-v1.0.bin    全量音色库（~26MB）

本地优先纪律（需求：联网下载前先检查这里有没有）：
- ensure_models 先逐文件查本地（存在且大小过合理性下限即复用），
  全部在位时绝不联网——支持用户手工放置文件做离线迁移；
- 下载走「同目录 .part 临时文件 + os.replace 原子改名」，
  中断/磁盘写坏不会留下「看似完整」的半截文件骗过下次本地检查；
- 音素化数据（espeak-ng-data）随 pip 包 espeakng-loader 自带，
  不属于用户数据，不重复管理。

推理（kokoro 为 82M 小模型，onnxruntime CPU 即可接近实时）：
- 单次合成：text → 24kHz 16bit WAV 字节（内容哈希缓存，与 edge-tts
  共用 caches/tts/ 但键前缀与扩展名区分，互不污染；缓存原子写入，
  中断不留半截文件骗过后续命中）；
- 批量合成（文本导入）：逐句合成 → 字节算术测长（免 ffprobe）→ 静音间隔
  → ffmpeg 拼接，拼装主路径与 tts_edge 共享 tts_common.assemble_timeline，
  返回每句起止毫秒。
"""

import os
import threading
import wave
from pathlib import Path
from typing import Callable

from .. import settings
from ..media.wav import wav_duration_ms
from .tts_common import SENTENCE_GAP_SEC, assemble_timeline, tts_cache_path, write_atomic

# kokoro 全部文件的存放目录（模型/音色/配置，一律不散落到别处）
KOKORO_DIR = Path(settings.MODELS_DIR) / "kokoro"

# 官方发布源（thewh1teagle/kokoro-onnx 的 model-files-v1.1 release，与 pip 包配套）
_DOWNLOAD_BASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"
)

# 模型文件清单：文件名 → 下载地址（fp32 版本：精听工具音质优先，
# 如需更小的 CPU 推理开销可换 kokoro-v1.0.int8.onnx，改此清单即可）
MODEL_FILES: dict[str, str] = {
    "kokoro-v1.0.onnx": f"{_DOWNLOAD_BASE}/kokoro-v1.0.onnx",
    "voices-v1.0.bin": f"{_DOWNLOAD_BASE}/voices-v1.0.bin",
}

# 各文件的大小下限（字节）：本地存在但小于此值视为残缺（手工拷贝被截断/
# 旧版本文件），需要重新下载。真实体积为 model≈310MB / voices≈26MB，
# 下限留足容差。
MIN_BYTES: dict[str, int] = {
    "kokoro-v1.0.onnx": 250 * 1024 * 1024,
    "voices-v1.0.bin": 20 * 1024 * 1024,
}

# 模型音频参数（kokoro 固定输出 24kHz；WAV 编码用 16bit 单声道）
SAMPLE_RATE = 24000

# 默认音色：英音男声（与 edge-tts 默认 Ryan 的「沉稳男声英音」定位对齐）
DEFAULT_VOICE = "bm_george"

# 英文音色清单（voices-v1.0.bin 内含多语言，这里只开放英文精听场景用得上的；
# 前缀约定 a=美音 b=英音，f=女声 m=男声；label 供 web 设置页下拉展示）
VOICE_OPTIONS: list[dict] = [
    # —— 英音（精听场景偏好，置顶）——
    {"value": "bm_george", "label": "George · 英音男声 · 沉稳"},
    {"value": "bm_fable", "label": "Fable · 英音男声 · 讲述"},
    {"value": "bf_emma", "label": "Emma · 英音女声 · 年轻"},
    {"value": "bf_isabella", "label": "Isabella · 英音女声 · 柔和"},
    # —— 美音 ——
    {"value": "af_heart", "label": "Heart · 美音女声 · 温暖"},
    {"value": "af_bella", "label": "Bella · 美音女声 · 柔和"},
    {"value": "af_nicole", "label": "Nicole · 美音女声 · 清亮"},
    {"value": "af_sarah", "label": "Sarah · 美音女声 · 播报"},
    {"value": "af_nova", "label": "Nova · 美音女声 · 明快"},
    {"value": "af_sky", "label": "Sky · 美音女声 · 少年感"},
    {"value": "af_river", "label": "River · 美音女声 · 中性"},
    {"value": "af_alloy", "label": "Alloy · 美音女声 · 中性"},
    {"value": "af_aoede", "label": "Aoede · 美音女声 · 叙事"},
    {"value": "af_jessica", "label": "Jessica · 美音女声 · 年轻"},
    {"value": "af_kore", "label": "Kore · 美音女声 · 坚定"},
    {"value": "am_adam", "label": "Adam · 美音男声 · 叙事"},
    {"value": "am_echo", "label": "Echo · 美音男声 · 叙事"},
    {"value": "am_eric", "label": "Eric · 美音男声 · 叙事"},
    {"value": "am_fenrir", "label": "Fenrir · 美音男声 · 叙事"},
    {"value": "am_liam", "label": "Liam · 美音男声 · 年轻"},
    {"value": "am_michael", "label": "Michael · 美音男声 · 叙事"},
    {"value": "am_onyx", "label": "Onyx · 美音男声 · 低沉"},
    {"value": "am_puck", "label": "Puck · 美音男声 · 明快"},
    {"value": "am_santa", "label": "Santa · 美音男声 · 特效"},
]

# 批量合成的句间静音间隔（秒）：双引擎同值，常量在 tts_common 单一来源
# SENTENCE_GAP_SEC 由 tts_common 导入

# 下载串行锁：模型下载任务与首个合成请求并发时只跑一份下载
_download_lock = threading.Lock()
# Kokoro 实例单例锁：构造重的 onnx 会话只建一次
_get_lock = threading.Lock()
# 推理锁：espeak 音素化非线程安全，create() 全程串行
_infer_lock = threading.Lock()

# 单例缓存：None=未构造；（实例, 构造所用音色文件）=已就绪
_kokoro: object | None = None


class TTSEngineError(RuntimeError):
    """kokoro TTS 执行失败（依赖缺失/模型未下载/推理异常）"""


# ---------------- 模型文件管理（本地优先） ----------------


def _file_ok(name: str) -> bool:
    """单文件是否在本地且完整（存在 + 大小过合理性下限）"""
    path = KOKORO_DIR / name
    try:
        return path.is_file() and path.stat().st_size >= MIN_BYTES.get(name, 1)
    except OSError:
        return False


def models_ready() -> bool:
    """kokoro 模型是否全部在位（不联网、不抛错，供能力探测与 UI 状态展示）"""
    return all(_file_ok(name) for name in MODEL_FILES)


def module_ready() -> bool:
    """kokoro-onnx 包是否可导入（不加载模型；模型下载前的先决检查）

    未装包时下载 336MB 毫无意义——推理一步就 ImportError，批量合成与模型
    下载任务都必须先过此检查（「下载几分钟完成后才报未安装」是最差体验）。
    """
    try:
        import kokoro_onnx  # noqa: F401, PLC0415

        return True
    except ImportError:
        return False


def _download(
    url: str,
    dest: Path,
    *,
    min_bytes: int,
    on_progress: Callable[[float, str], None] | None = None,
) -> None:
    """流式下载单个文件到 dest（.part 临时文件 + 原子改名 + 大小校验）

    Args:
        url:        官方下载地址（GitHub release，会 302 到 CDN，需跟随重定向）
        dest:       目标路径（最终文件名）
        min_bytes:  完整性下限（Content-Length 缺失时也用它兜底校验）
        on_progress: 该文件的下载进度回调（0~1 + 说明文案）
    Raises:
        TTSEngineError: 网络失败 / HTTP 异常 / 下载不完整
    """
    import httpx  # noqa: PLC0415 —— 核心层依赖，延迟导入保持模块轻

    label = dest.name
    part = dest.with_name(dest.name + ".part")
    try:
        with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0)) as client:
            with client.stream("GET", url) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length") or 0)
                done = 0
                with open(part, "wb") as f:  # noqa: SIM115 —— with 内明确关闭
                    for chunk in resp.iter_bytes(chunk_size=256 * 1024):
                        f.write(chunk)
                        done += len(chunk)
                        if on_progress and total:
                            on_progress(done / total, f"下载 {label} {done / total * 100:.0f}%")
        # 完整性校验：Content-Length 缺失或对不上时，至少不能小于下限
        size = part.stat().st_size
        if size < min_bytes or (total and size != total):
            raise TTSEngineError(
                f"下载不完整：{label}（{size} 字节，期望 {total or '≥' + str(min_bytes)}），请重试"
            )
        os.replace(part, dest)  # 原子改名：此后本地检查才能看到完整文件
    except TTSEngineError:
        part.unlink(missing_ok=True)
        raise
    except Exception as exc:  # noqa: BLE001 —— 网络/IO 异常统一包装
        part.unlink(missing_ok=True)
        raise TTSEngineError(f"下载 {label} 失败：{exc}") from exc


def ensure_models(
    on_progress: Callable[[float, str], None] | None = None,
) -> list[str]:
    """确保 kokoro 模型/音色文件在位：先查本地，缺哪个才联网补哪个（阻塞，调用方放线程池）

    Args:
        on_progress: 总体进度回调（0~1 + 说明文案；多文件按预期体量加权）
    Returns:
        本次实际下载的文件名列表（本地已全齐则返回空列表、零网络请求）
    Raises:
        TTSEngineError: 任一文件下载失败
    """
    KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    with _download_lock:
        # 先查本地：在位（且大小合理）的文件直接复用，不发起任何网络请求
        todo = [name for name in MODEL_FILES if not _file_ok(name)]
        if not todo:
            if on_progress:
                on_progress(1.0, "kokoro 模型已就绪（本地复用）")
            return []
        # 进度按文件数均分（两个文件体量同量级，均分够用）
        span = 1.0 / len(todo)
        for i, name in enumerate(todo):
            base = i * span
            _download(
                MODEL_FILES[name],
                KOKORO_DIR / name,
                min_bytes=MIN_BYTES.get(name, 1),
                on_progress=(
                    (lambda p, msg, b=base, s=span, n=name: on_progress(b + p * s, msg))
                    if on_progress
                    else None
                ),
            )
        if on_progress:
            on_progress(1.0, "kokoro 模型下载完成")
        return todo


# ---------------- Kokoro 实例与推理 ----------------


def _lang_for(voice: str) -> str:
    """按音色名前缀推断音素化语言（kokoro 约定：b*=英音 en-gb，其余英文=美音 en-us）"""
    return "en-gb" if voice.startswith("b") else "en-us"


def _require_models() -> None:
    """模型未就绪时给出可执行的指引（同步单次路径不静默触发大下载）"""
    if not models_ready():
        raise TTSEngineError(
            "kokoro 模型未下载（模型+音色约 336MB）：请在「设置 → 本地 AI 引擎」"
            "点击下载，或先跑一次文本导入任务自动下载到 ~/.pinglc/models/kokoro/"
        )


def _get_kokoro():
    """加载（或复用）Kokoro 推理实例（线程安全；构造失败不缓存）"""
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    with _get_lock:
        if _kokoro is not None:
            return _kokoro
        _require_models()
        try:
            from kokoro_onnx import Kokoro  # noqa: PLC0415

        except ImportError as exc:
            raise TTSEngineError(
                "kokoro-onnx 未安装：运行 ./scripts/engine-setup.sh 安装 tts 层"
            ) from exc
        try:
            _kokoro = Kokoro(
                str(KOKORO_DIR / "kokoro-v1.0.onnx"),
                str(KOKORO_DIR / "voices-v1.0.bin"),
            )
        except Exception as exc:  # noqa: BLE001 —— 会话构造异常统一包装并允许重试
            raise TTSEngineError(f"kokoro 模型加载失败：{exc}") from exc
        return _kokoro


def parse_rate(rate: str | float | None) -> float:
    """语速参数解析：兼容 edge 风格百分比串（如 "-10%"/"+20%"）与裸浮点

    越界值收拢到 kokoro 支持的 0.5~2.0；无法解析回退 1.0。
    """
    if rate is None:
        return 1.0
    if isinstance(rate, (int, float)):
        value = float(rate)
    else:
        text = rate.strip()
        pct = text.endswith("%")
        num = text.rstrip("%").lstrip("+")
        try:
            value = float(num) if num else 1.0
        except ValueError:
            return 1.0
        if pct:
            value = 1.0 + value / 100.0  # 百分比串语义：-10% → 0.9 倍速
        elif not (0.5 <= value <= 2.0):
            value = 1.0 + value / 100.0  # 无百分号但量纲明显是百分比（如 "120"）
    return max(0.5, min(2.0, round(value, 2)))


def _encode_wav(samples) -> bytes:
    """float32 采样（-1~1，任意可转 np.ndarray 的序列）→ 24kHz 16bit 单声道 WAV 字节"""
    import io

    import numpy as np  # noqa: PLC0415 —— kokoro-onnx 依赖自带

    arr = np.asarray(samples, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)  # 单声道
        w.setsampwidth(2)  # 16bit
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def cache_path(text: str, voice: str, speed: float) -> Path:
    """合成缓存路径（"kokoro|voice|speed|text" 的 sha256 → wav；kokoro| 前缀与
    edge-tts / 云端键空间隔离）

    text 先 strip——与 synthesize 的清洗一致：调用方传原始文本（含首尾空白）
    也算出与合成产物相同的路径。哈希与落位走 tts_common.tts_cache_path。
    """
    return tts_cache_path(f"kokoro|{voice}|{speed:.2f}|{text.strip()}", "wav")


def _synthesize_cached(text: str, voice: str, speed: float) -> tuple[bytes, Path]:
    """单次合成核心：文本 → (WAV 字节, 缓存路径)；缓存命中零推理零写入

    Args:
        text:  待合成文本（先 strip；空文本报错）
        voice: kokoro 音色名（如 bm_george；不在音色库会由 Kokoro 抛错）
        speed: 语速倍率（0.5~2.0）
    Raises:
        TTSEngineError: 依赖缺失/模型未下载/推理失败
    """
    text = text.strip()
    if not text:
        raise TTSEngineError("待合成文本为空")

    cache = cache_path(text, voice, speed)
    if cache.is_file():
        return cache.read_bytes(), cache

    kokoro = _get_kokoro()
    try:
        with _infer_lock:  # espeak 音素化非线程安全，推理全程串行
            result = kokoro.create(text, voice=voice, speed=speed, lang=_lang_for(voice))
    except TTSEngineError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise TTSEngineError(f"kokoro 合成失败：{exc}") from exc
    # 兼容不同版本的返回形态：新版本 (samples, sr)，个别版本仅 samples
    samples = result[0] if isinstance(result, tuple) else result
    if samples is None or len(samples) == 0:
        raise TTSEngineError("kokoro 未返回音频")
    data = _encode_wav(samples)
    write_atomic(cache, data)  # 原子写：崩溃不留半截 wav 骗过后续缓存命中
    return data, cache


def synthesize(text: str, *, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> bytes:
    """单次合成（带缓存）：文本 → 24kHz 16bit WAV 字节（阻塞，调用方放线程池）

    Args:
        text:  待合成文本（web 侧已限长 500 字符内）
        voice: kokoro 音色名（如 bm_george）
        speed: 语速倍率（0.5~2.0）
    Returns:
        WAV 文件字节（同时已原子写入缓存，cache_path 可复算同一位置）
    """
    return _synthesize_cached(text, voice, speed)[0]


def _wav_duration_ms_of(path: Path) -> int:
    """由 WAV 文件头部算时长（wave 模块 open 只读头不载帧数据；解析失败回 0）"""
    try:
        with wave.open(str(path), "rb") as w:
            # 整除对齐 wav_duration_ms 的 floor 语义：命中/未命中两条路径对同一句
            # 必须给出相同毫秒数，否则首次与重复导入的时间轴会有毫秒级漂移
            return w.getnframes() * 1000 // w.getframerate()
    # EOFError：空/截断的缓存文件在 wave 读头阶段抛出（不是 wave.Error 子类）
    except (wave.Error, EOFError, OSError, ZeroDivisionError):
        return 0


def _synthesize_for_batch(text: str, voice: str, speed: float) -> tuple[bytes | None, Path, int]:
    """批量合成单句：缓存命中只回 (None, 缓存路径, 时长)

    整批命中时不再把每句 WAV 全量读回内存——此前 500 句的重复导入要白读
    ~120MB 只为算时长；字节仅在硬链接失败需要实写分片时才回读。
    Raises:
        TTSEngineError: 依赖缺失/模型未下载/推理失败（同 _synthesize_cached）
    """
    cache = cache_path(text, voice, speed)
    if cache.is_file():
        return None, cache, _wav_duration_ms_of(cache)
    data, cache_after = _synthesize_cached(text, voice, speed)
    return data, cache_after, wav_duration_ms(data, sample_rate=SAMPLE_RATE)


def ensure_synthesized(text: str, *, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> Path:
    """确保合成产物已在缓存就位并返回其路径（缓存命中时不读回字节）

    /tts 端点用：产物交给 web 代理单次读取，size 由调用方 stat——
    引擎侧不再为拿个长度把整段音频读进内存（此前缓存命中也全量读一遍）。
    """
    cache = cache_path(text, voice, speed)
    if not cache.is_file():
        _synthesize_cached(text, voice, speed)
    return cache


def synthesize_batch(
    sentences: list[str],
    out_path: str,
    *,
    voice: str = DEFAULT_VOICE,
    speed: float = 1.0,
    gap_sec: float = SENTENCE_GAP_SEC,
    on_progress: Callable[[float], None] | None = None,
) -> list[dict]:
    """批量合成整卷音频（文本导入主路径，拼装与 tts_edge 共享 tts_common）

    逐句合成 WAV 分片（硬链接复用缓存，省一次磁盘写）→ 字节算术测长
    （RIFF 头 24kHz 换算，免 ffprobe 子进程）→ 静音间隔 → ffmpeg 拼接。
    模型须已在位（长任务路径由调用方先 ensure_models 带进度下载）。
    Returns:
        每句时间轴 [{startMs, endMs}, ...]（含句间静音间隔）
    Raises:
        TTSEngineError: 任一句失败或拼接失败
    """
    if not sentences:
        raise TTSEngineError("句子列表为空")

    _require_models()
    out_dir = Path(out_path).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / ".tts-parts"
    work.mkdir(exist_ok=True)

    # 逐句合成（kokoro 推理本身串行，此处顺序执行；缓存命中时近零成本——
    # 命中态不读回字节，时长由 WAV 头部算得）。分片硬链接到缓存文件（同盘
    # 零拷贝），跨设备等失败再退回实写（此时才回读字节）
    parts: list[str] = []
    durations: list[int] = []
    for i, text in enumerate(sentences):
        data, cache, dur = _synthesize_for_batch(text, voice=voice, speed=speed)
        part = work / f"{i:05d}.wav"
        try:
            os.link(cache, part)
        except OSError:
            part.write_bytes(data if data is not None else cache.read_bytes())
        parts.append(str(part))
        # WAV 分片时长：未命中由字节算术、命中由文件头（免逐句 ffprobe 子进程）
        durations.append(dur)
        if on_progress:
            on_progress((i + 1) / (len(sentences) + 1))

    return assemble_timeline(
        parts, out_path, gap_sec=gap_sec, part_durations_ms=durations, on_progress=on_progress,
    )
