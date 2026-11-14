"""
本地 STT 引擎：faster-whisper 封装

- 单模型常驻：换规格时卸载旧模型（显存纪律 —— 单卡 16GB 只养一个 STT 模型）
- 词级时间戳 + 逐段进度回调（供 JobRunner 汇报 progress）
- transcribe 为同步阻塞（CTranslate2 推理），调用方用 asyncio.to_thread 包装
- 结果只含扁平词流：分句由 web 端 @pinglc/core 完成（引擎不懂业务）
"""

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .. import settings

# 模型缓存键 → 已加载模型；同一时刻至多一个（换规格先卸载旧的）
_model_lock = threading.Lock()
_loaded: dict[str, Any] = {}
_loaded_key: str | None = None


class STTEngineError(RuntimeError):
    """STT 执行失败（依赖缺失/文件问题/推理异常）"""


@dataclass
class STTResult:
    """转写结果：语言、总时长、扁平词流（w=词 s/e=秒 p=置信度）"""

    language: str
    duration: float
    words: list[dict]


def _resolve_device(requested: str | None) -> str:
    """解析计算设备：auto → 探测 CUDA，否则 cpu"""
    if requested and requested != "auto":
        return requested
    try:
        import ctranslate2  # noqa: PLC0415

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:  # noqa: BLE001
        return "cpu"


def _load(model_spec: str, device: str) -> Any:
    """加载（或复用）STT 模型；换规格时卸载旧模型释放显存"""
    global _loaded_key
    key = f"{model_spec}@{device}"
    with _model_lock:
        if _loaded_key == key and key in _loaded:
            return _loaded[key]
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415
        except ImportError as exc:
            raise STTEngineError(
                "faster-whisper 未安装：运行 ./scripts/engine-setup.sh 安装 stt 层"
            ) from exc
        # GPU 用 int8_float16（精度/速度/显存平衡），CPU 用 int8
        compute = "int8_float16" if device == "cuda" else "int8"
        model_dir = str(Path(settings.MODELS_DIR) / "faster-whisper")
        model = WhisperModel(
            model_spec,
            device=device,
            compute_type=compute,
            download_root=model_dir,
        )
        # 卸载旧模型（置 None 释放引用，交由 GC 回收显存）
        if _loaded_key and _loaded_key != key:
            _loaded.pop(_loaded_key, None)
        _loaded[key] = model
        _loaded_key = key
        return model


def transcribe(
    audio_path: str,
    *,
    model_spec: str = "large-v3",
    language: str | None = "en",
    device: str | None = None,
    vad_filter: bool = True,
    initial_prompt: str | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> STTResult:
    """执行转写：返回扁平词流（阻塞，调用方负责放线程池）

    Args:
        audio_path:     音频/视频文件绝对路径（faster-whisper 内置 ffmpeg 解码）
        model_spec:     模型规格（tiny/base/small/medium/large-v3 或本地目录）
        language:       强制语言（精听场景固定 en；None=自动检测）
        device:         cuda / cpu / None=auto
        vad_filter:     VAD 预过滤（静音段不进模型，提速且减少幻听）
        initial_prompt: 提示词（领域词汇引导，如专有名词）
        on_progress:    进度回调（0~1，按段落推进）
    Raises:
        STTEngineError: 依赖缺失或推理失败
    """
    if not Path(audio_path).is_file():
        raise STTEngineError(f"音频文件不存在：{audio_path}")

    dev = _resolve_device(device)
    model = _load(model_spec, dev)

    try:
        segments_iter, info = model.transcribe(
            audio_path,
            language=language,
            word_timestamps=True,
            vad_filter=vad_filter,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt,
        )
    except Exception as exc:  # noqa: BLE001
        raise STTEngineError(f"转写启动失败：{exc}") from exc

    duration = float(info.duration or 0.0)
    words: list[dict] = []
    try:
        for seg in segments_iter:
            seg_words = getattr(seg, "words", None) or []
            for w in seg_words:
                words.append(
                    {
                        "w": w.word.strip(),
                        "s": round(float(w.start), 3),
                        "e": round(float(w.end), 3),
                        "p": round(float(w.probability or 0.0), 3),
                    }
                )
            if on_progress and duration > 0:
                on_progress(min(0.99, float(seg.end) / duration))
    except Exception as exc:  # noqa: BLE001
        raise STTEngineError(f"转写中断：{exc}") from exc

    if on_progress:
        on_progress(1.0)
    return STTResult(
        language=str(info.language or (language or "")),
        duration=duration,
        words=words,
    )
