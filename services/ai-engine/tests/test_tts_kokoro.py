"""
kokoro TTS 引擎测试：模型落盘检查 / 本地优先不联网 / 下载原子性与完整性 /
音色语言推断 / 语速解析 / WAV 编码 / 缓存键

不依赖 kokoro-onnx 与 numpy 的安装（重依赖按层可选）：推理路径只测到
「模型未就绪 / 包未安装」的错误分支，纯逻辑全部可离线验证。
"""

import importlib.util
import io
import wave

import httpx
import pytest

from app import settings
from app.engines import tts_kokoro


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """目录常量与文件清单指到临时 PINGLC_HOME（模式沿袭 test_settings）"""
    home = tmp_path / "pinglc-home"
    monkeypatch.setattr(settings, "PINGLC_HOME", home)
    monkeypatch.setattr(settings, "MODELS_DIR", home / "models")
    monkeypatch.setattr(settings, "CACHES_DIR", home / "caches")
    # 引擎模块内的目录常量与大小下限同步打补丁（下限改小，测试不必写真 300MB 文件）
    monkeypatch.setattr(tts_kokoro, "KOKORO_DIR", home / "models" / "kokoro")
    monkeypatch.setattr(
        tts_kokoro,
        "MIN_BYTES",
        {"kokoro-v1.0.onnx": 8, "voices-v1.0.bin": 8},
    )
    return home


def _place_files(names, size=16):
    """在临时模型目录放置「完整」假文件（大小过下限）"""
    tts_kokoro.KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    for name in names:
        (tts_kokoro.KOKORO_DIR / name).write_bytes(b"x" * size)


# ---------------- 模型在位检查 ----------------


def test_models_ready_false_when_missing(isolated):
    """无任何文件：未就绪"""
    assert tts_kokoro.models_ready() is False


def test_models_ready_true_when_files_present(isolated):
    """两文件齐全且过大小下限：就绪"""
    _place_files(["kokoro-v1.0.onnx", "voices-v1.0.bin"])
    assert tts_kokoro.models_ready() is True


def test_models_ready_false_when_truncated(isolated):
    """文件在但小于下限（手工拷贝被截断）：视为残缺，不算在位"""
    tts_kokoro.KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    (tts_kokoro.KOKORO_DIR / "kokoro-v1.0.onnx").write_bytes(b"x" * 16)
    (tts_kokoro.KOKORO_DIR / "voices-v1.0.bin").write_bytes(b"x" * 4)  # 小于下限 8
    assert tts_kokoro.models_ready() is False


# ---------------- 本地优先 / 下载 ----------------


def test_ensure_models_all_local_never_touches_network(isolated):
    """文件全在位：零网络请求（_download 被调即失败），进度直接到 1.0"""
    _place_files(["kokoro-v1.0.onnx", "voices-v1.0.bin"])

    def _fail(*args, **kwargs):  # noqa: ANN001
        """替身下载：一旦被调即失败（本地已齐全时不应联网）"""
        raise AssertionError("本地已齐全，不应联网下载")

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(tts_kokoro, "_download", _fail)
    try:
        seen = []
        downloaded = tts_kokoro.ensure_models(lambda p, msg: seen.append((p, msg)))
        assert downloaded == []
        assert seen[-1][0] == 1.0  # 进度收尾到 1.0
    finally:
        monkeypatch.undo()


def test_ensure_models_downloads_only_missing(isolated):
    """缺哪个补哪个：模型在位只下载音色文件；进度单调且到 1.0"""
    _place_files(["kokoro-v1.0.onnx"])
    calls = []

    def _fake_download(url, dest, *, min_bytes, on_progress=None):
        """替身下载：记录目标名并落盘完整假文件（带进度回调）"""
        calls.append(dest.name)
        dest.write_bytes(b"y" * 16)
        if on_progress:
            on_progress(1.0, f"下载 {dest.name} 100%")

    mp = pytest.MonkeyPatch()
    mp.setattr(tts_kokoro, "_download", _fake_download)
    try:
        progress = []
        downloaded = tts_kokoro.ensure_models(lambda p, msg: progress.append(p))
        assert downloaded == ["voices-v1.0.bin"]
        assert calls == ["voices-v1.0.bin"]  # 在位文件未被重复下载
        assert progress == [1.0, 1.0]  # 单文件下载收尾 + ensure 总收尾
        assert tts_kokoro.models_ready() is True
    finally:
        mp.undo()


class _FakeResponse:
    """httpx 流式响应替身：按块吐字节"""

    def __init__(self, chunks: list[bytes], total: int, status: int = 200):
        """按块序列与声明总量构造响应（headers 供完整性校验读取）"""
        self._chunks = chunks
        self.headers = {"content-length": str(total)}
        self.status_code = status

    def raise_for_status(self):
        """状态码 ≥400 时抛错（模拟 HTTP 层失败）"""
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_bytes(self, chunk_size=None):  # noqa: ARG002
        """依序吐出预设字节块（模拟流式下载体）"""
        yield from self._chunks


class _FakeStreamCtx:
    """client.stream(...) 返回的上下文管理器"""

    def __init__(self, resp):
        """绑定待返回的响应对象"""
        self._resp = resp

    def __enter__(self):
        """进入上下文：交出响应"""
        return self._resp

    def __exit__(self, *exc):
        """退出上下文：不吞异常"""
        return False


class _FakeClient:
    """httpx.Client 替身：按提交顺序回放预设响应"""

    queue: list[_FakeResponse] = []

    def __init__(self, **kwargs):  # noqa: ANN003, ARG002
        """忽略构造参数（超时等），仅维持接口形态"""

    def __enter__(self):
        """进入上下文：返回自身"""
        return self

    def __exit__(self, *exc):
        """退出上下文：不吞异常"""
        return False

    def stream(self, method, url):  # noqa: ANN001, ARG002
        """弹出队首预设响应包装为流式上下文"""
        return _FakeStreamCtx(type(self).queue.pop(0))


def test_download_writes_part_then_atomic_rename(isolated, monkeypatch):
    """成功路径：内容完整写入最终路径，.part 残骸被原子改名消费"""
    _FakeClient.queue = [_FakeResponse([b"abcd", b"efgh"], total=8)]
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    dest = tts_kokoro.KOKORO_DIR / "voices-v1.0.bin"
    tts_kokoro.KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    seen = []
    tts_kokoro._download(
        "https://example.com/voices.bin", dest,
        min_bytes=8, on_progress=lambda p, msg: seen.append(p),
    )
    assert dest.read_bytes() == b"abcdefgh"
    assert not dest.with_name(dest.name + ".part").exists()
    assert seen and seen[-1] == 1.0


def test_download_rejects_truncated_and_cleans_part(isolated, monkeypatch):
    """完整性校验：总字节小于下限时抛错，.part 清理、目标文件不出现"""
    _FakeClient.queue = [_FakeResponse([b"abc"], total=3)]  # 小于 min_bytes=8
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    dest = tts_kokoro.KOKORO_DIR / "kokoro-v1.0.onnx"
    tts_kokoro.KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    with pytest.raises(tts_kokoro.TTSEngineError, match="下载不完整"):
        tts_kokoro._download("https://example.com/model.onnx", dest, min_bytes=8)
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()


def test_download_wraps_network_error(isolated, monkeypatch):
    """网络层异常被包装为 TTSEngineError 且不留残骸"""
    class _Boom(_FakeResponse):
        """读体阶段抛网络错误的响应（模拟下载中途断连）"""

        def iter_bytes(self, chunk_size=None):  # noqa: ARG002
            """吐块前抛 OSError（模拟连接被重置）"""
            raise OSError("connection reset")

    _FakeClient.queue = [_Boom([b"x"], total=1)]
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    dest = tts_kokoro.KOKORO_DIR / "kokoro-v1.0.onnx"
    tts_kokoro.KOKORO_DIR.mkdir(parents=True, exist_ok=True)
    with pytest.raises(tts_kokoro.TTSEngineError, match="下载"):
        tts_kokoro._download("https://example.com/model.onnx", dest, min_bytes=8)
    assert not dest.with_name(dest.name + ".part").exists()


# ---------------- 纯逻辑 ----------------


@pytest.mark.parametrize(
    ("rate", "expected"),
    [
        ("+0%", 1.0),
        ("-10%", 0.9),
        ("+25%", 1.25),
        ("1.5", 1.5),
        ("0.9", 0.9),
        ("300%", 2.0),   # 越界收拢
        ("120", 2.0),    # 无百分号但量纲是百分比 → 2.2 → 收拢 2.0
        ("abc", 1.0),    # 无法解析回退
        ("", 1.0),
        (None, 1.0),
    ],
)
def test_parse_rate(rate, expected):
    """语速解析：edge 风格百分比串 / 裸浮点 / 垃圾值回退 / 越界收拢"""
    assert tts_kokoro.parse_rate(rate) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("voice", "lang"),
    [
        ("bm_george", "en-gb"),
        ("bf_emma", "en-gb"),
        ("af_heart", "en-us"),
        ("am_adam", "en-us"),
    ],
)
def test_lang_for_voice(voice, lang):
    """语言推断：b 前缀（英音）→ en-gb，其余英文音色 → en-us"""
    assert tts_kokoro._lang_for(voice) == lang


def test_cache_path_shape_and_sensitivity(isolated):
    """缓存路径：落 caches/tts/ 下、.wav 后缀、对音色/语速敏感且稳定"""
    p1 = tts_kokoro.cache_path("hello", "bm_george", 1.0)
    p2 = tts_kokoro.cache_path("hello", "bm_george", 1.0)
    p3 = tts_kokoro.cache_path("hello", "af_heart", 1.0)
    p4 = tts_kokoro.cache_path("hello", "bm_george", 1.2)
    assert p1 == p2
    assert p1 != p3 and p1 != p4
    assert p1.parent == settings.CACHES_DIR / "tts"
    assert p1.suffix == ".wav"


def test_synthesize_requires_models(isolated):
    """模型未就绪：给出含下载指引的错误（同步路径不静默触发大下载）"""
    with pytest.raises(tts_kokoro.TTSEngineError, match="未下载"):
        tts_kokoro.synthesize("hello")


@pytest.mark.skipif(
    importlib.util.find_spec("kokoro_onnx") is not None,
    reason="kokoro-onnx 已安装的环境会真的加载假模型文件，跳过此分支",
)
def test_synthesize_requires_package(isolated):
    """文件在位但 pip 包未装：指引运行 engine-setup.sh"""
    _place_files(["kokoro-v1.0.onnx", "voices-v1.0.bin"])
    with pytest.raises(tts_kokoro.TTSEngineError, match="未安装"):
        tts_kokoro.synthesize("hello")


def test_encode_wav():
    """WAV 编码：float32 → 24kHz 16bit 单声道，幅度映射正确"""
    np = pytest.importorskip("numpy")
    samples = [0.0, 0.5, -0.5, 1.0]
    data = tts_kokoro._encode_wav(np.asarray(samples, dtype=np.float32))
    with wave.open(io.BytesIO(data), "rb") as w:
        assert w.getframerate() == 24000
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        frames = list(w.readframes(w.getnframes()))
        assert w.getnframes() == 4
    # 字节序小端：每帧 2 字节；0.5*32767=16383.5 → 截断 16383
    assert frames[0:2] == [0, 0]
    assert frames[2:4] == [0xFF, 0x3F]  # 16383
    assert frames[4:6] == [0x01, 0xC0]  # -16383 的补码低/高字节
    assert frames[6:8] == [0xFF, 0x7F]  # 32767


def test_voice_options_sane():
    """音色清单：默认音色在列、取值符合 kokoro 命名、标签不重复"""
    values = [v["value"] for v in tts_kokoro.VOICE_OPTIONS]
    labels = [v["label"] for v in tts_kokoro.VOICE_OPTIONS]
    assert tts_kokoro.DEFAULT_VOICE in values
    assert len(labels) == len(set(labels))
    for value in values:
        prefix, name = value.split("_")
        assert len(prefix) == 2 and prefix[0] in "ab" and prefix[1] in "fm"
        assert name.islower() and name.isalpha()
