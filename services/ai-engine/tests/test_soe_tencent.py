"""
腾讯云 SOE 口语评测引擎测试：签名与 URL 构造 / 评测模式选择 / 文本清洗 /
苛刻指数解析 / 结果归一化 / 错误码映射 / WS 会话流程（含错误分支）

不联网、不跑真 ffmpeg（转码打替身）；WS 客户端用脚本化假连接器回放消息序列。
签名期望值为独立实现的 HMAC-SHA1 固定向量（与模块实现互为印证）。
"""

import asyncio
import base64
import hmac
from pathlib import Path

import pytest

from app.engines import soe_tencent


# ---------------- 签名与 URL 构造 ----------------

# 固定向量：build_ws_url(..., voice_id/timestamp/nonce 固定) 的期望签名
# （由独立脚本以同一算法预先计算：sorted params → host+path 拼接 → HMAC-SHA1 → Base64）
_EXPECTED_SIGNATURE = "hdQFuFPAZGIwv17jg7dT1OCigx0="


def _fixed_url(**overrides):
    """固定时间/nonce/voice_id 的 URL 构造（签名可复现）"""
    kwargs = dict(
        ref_text="hello world",
        score_coeff=2.0,
        language="en",
        voice_id="abc123",
        timestamp=1700000000,
        nonce=1234567890,
    )
    kwargs.update(overrides)
    return soe_tencent.build_ws_url(
        "wss://soe.cloud.tencent.com/soe/api", "125000000", "AKIDtest", "secret", **kwargs
    )


def test_build_ws_url_independent_recompute():
    """独立重算：按文档规则（排序、未编码、host+path、appid 入路径）复现签名"""
    from urllib.parse import unquote

    params = {
        "secretid": "AKIDtest",
        "timestamp": "1700000000",
        "expired": "1700003600",
        "nonce": "1234567890",
        "server_engine_type": "16k_en",
        "voice_id": "abc123",
        "voice_format": "1",
        "ref_text": "hello world",
        "eval_mode": "1",
        "score_coeff": "2",
        "rec_mode": "1",
        "sentence_info_enabled": "0",
    }
    base = "soe.cloud.tencent.com/soe/api/125000000?" + "&".join(
        f"{k}={params[k]}" for k in sorted(params)
    )
    expected = base64.b64encode(hmac.new(b"secret", base.encode(), "sha1").digest()).decode()
    # 固定向量与独立实现一致（防两头同错：向量来自文档算法的手工演算）
    assert _EXPECTED_SIGNATURE == expected
    # 模块输出与独立实现一致（解码后比对，签名在真实 URL 中是 urlencode 形态）
    url = unquote(_fixed_url())
    assert f"signature={expected}" in url
    # 请求参数齐全（录音模式 / wav / 英文引擎 / 句子模式）
    for frag in ("rec_mode=1", "voice_format=1", "server_engine_type=16k_en", "eval_mode=1"):
        assert frag in url


def test_build_ws_url_custom_endpoint():
    """自定义服务地址：host+path 进签名与连接 URL（尾斜杠容忍）"""
    url = soe_tencent.build_ws_url(
        "wss://soe.example.com/soe/api/", "1", "id", "key",
        ref_text="hi", score_coeff=1.0, language="en",
        voice_id="v", timestamp=100, nonce=1,
    )
    assert url.startswith("wss://soe.example.com/soe/api/1?")


def test_build_ws_url_invalid_endpoint():
    """无 host 的服务地址：明确报错（而非拼出畸形 URL）"""
    with pytest.raises(soe_tencent.SoeError):
        soe_tencent.build_ws_url(
            "not-a-url", "1", "id", "key", ref_text="hi", score_coeff=1.0, language="en"
        )


# ---------------- 纯逻辑：文本 / 模式 / 参数 ----------------


def test_sanitize_ref_text():
    """竖线（SOE 多分支语法）替换为空格，首尾空白去除"""
    assert soe_tencent.sanitize_ref_text("  hello | world ") == "hello   world"


def test_pick_eval_mode_boundaries():
    """≤30 词句子模式(1)；31 词起段落模式(2)；>120 词或空文本报错"""
    assert soe_tencent.pick_eval_mode("one two three") == 1
    assert soe_tencent.pick_eval_mode(" ".join(["w"] * 30)) == 1
    assert soe_tencent.pick_eval_mode(" ".join(["w"] * 31)) == 2
    assert soe_tencent.pick_eval_mode(" ".join(["w"] * 120)) == 2
    with pytest.raises(soe_tencent.SoeError):
        soe_tencent.pick_eval_mode(" ".join(["w"] * 121))
    with pytest.raises(soe_tencent.SoeError):
        soe_tencent.pick_eval_mode("   ")


def test_parse_score_coeff():
    """合法范围内透传；越界/非法/缺省回落默认值"""
    assert soe_tencent.parse_score_coeff(3) == 3.0
    assert soe_tencent.parse_score_coeff("2.5") == 2.5
    assert soe_tencent.parse_score_coeff("4.0") == 4.0
    assert soe_tencent.parse_score_coeff(None) == soe_tencent.DEFAULT_SCORE_COEFF
    assert soe_tencent.parse_score_coeff("abc") == soe_tencent.DEFAULT_SCORE_COEFF
    assert soe_tencent.parse_score_coeff(9) == soe_tencent.DEFAULT_SCORE_COEFF
    assert soe_tencent.parse_score_coeff(0.5) == soe_tencent.DEFAULT_SCORE_COEFF


def test_server_engine_type():
    """语言 → 引擎型号：zh* 中文，其余英文"""
    assert soe_tencent.server_engine_type("en") == "16k_en"
    assert soe_tencent.server_engine_type("zh") == "16k_zh"


def test_error_text_known_and_unknown():
    """已知码给中文提示；未知码透传原始 message"""
    assert "资源包耗尽" in soe_tencent._error_text(4004, "x")
    assert "鉴权失败" in soe_tencent._error_text(4002, "x")
    assert "boom" in soe_tencent._error_text(9999, "boom")


# ---------------- 结果归一化 ----------------

# SOE 返回样例（result 为序列化字符串）：覆盖 匹配/错读/增读/漏读 四种词与音素明细
# MatchTag 语义（文档 1774/107384）：0 匹配 / 1 增读 / 2 漏读 / 3 错读 / 4 未录入
_SAMPLE_RESULT = {
    "SuggestedScore": 87.5,
    "PronAccuracy": 88.0,
    "PronFluency": 90.2,
    "PronCompletion": 1.0,
    "Status": "Success",
    "Words": [
        {
            "Word": "hello",
            "ReferenceWord": "hello",
            "MemBeginTime": 100,
            "MemEndTime": 400,
            "PronAccuracy": 91.5,
            "MatchTag": 0,
            "PhoneInfos": [
                {
                    "Phone": "hh",
                    "ReferencePhone": "hh",
                    "PronAccuracy": 92.0,
                    "MatchTag": 0,
                    "Stress": False,
                    "DetectedStress": True,
                }
            ],
        },
        {"Word": "word", "ReferenceWord": "world", "MemBeginTime": 500, "MemEndTime": 800,
         "PronAccuracy": 0.0, "MatchTag": 3, "PhoneInfos": []},
        {"Word": "uh", "ReferenceWord": "", "MemBeginTime": 900, "MemEndTime": 950,
         "PronAccuracy": 60.0, "MatchTag": 1, "PhoneInfos": []},
        {"Word": "", "ReferenceWord": "today", "MemBeginTime": 0, "MemEndTime": 0,
         "PronAccuracy": -1.0, "MatchTag": 2, "PhoneInfos": []},
    ],
}


def test_normalize_result():
    """PascalCase → snake_case：三维分、词级、音素级逐项核对"""
    import orjson

    out = soe_tencent.normalize_result(orjson.dumps(_SAMPLE_RESULT))
    assert out["score"] == pytest.approx(87.5)
    assert out["accuracy"] == pytest.approx(88.0)
    assert out["fluency"] == pytest.approx(90.2)
    assert out["completion"] == pytest.approx(1.0)
    assert out["status"] == "Success"
    # 匹配=0 / 错读=3 / 增读=1 / 漏读=2（漏读词 accuracy=-1、无时间戳）
    assert [w["match_tag"] for w in out["words"]] == [0, 3, 1, 2]
    hello = out["words"][0]
    assert hello["word"] == "hello"
    assert hello["begin_ms"] == 100 and hello["end_ms"] == 400
    assert hello["phones"][0]["phone"] == "hh"
    assert hello["phones"][0]["detected_stress"] is True
    missed = out["words"][3]
    assert missed["word"] == "today" and missed["accuracy"] == -1.0


def test_normalize_result_legacy_time_fields():
    """旧版字段名 BeginTime/EndTime 兜底：无 Mem 前缀字段时仍取到时间戳"""
    out = soe_tencent.normalize_result(
        {"Words": [{"Word": "hi", "BeginTime": 10, "EndTime": 20, "MatchTag": 0}]}
    )
    assert out["words"][0]["begin_ms"] == 10 and out["words"][0]["end_ms"] == 20


def test_normalize_result_accepts_dict_and_empty():
    """result 已是 dict 也能归一化；空载荷不炸（字段兜底为 0/空）"""
    out = soe_tencent.normalize_result({})
    assert out["words"] == [] and out["score"] == 0.0
    out2 = soe_tencent.normalize_result({"SuggestedScore": 50.0})
    assert out2["score"] == 50.0


def test_normalize_result_fluency_scale():
    """流利度双标度：≤1 视为比率放大为百分制（真机实测形态）；>1 透传（文档示例形态）"""
    ratio = soe_tencent.normalize_result({"PronFluency": 0.911})
    assert ratio["fluency"] == pytest.approx(91.1)
    pct = soe_tencent.normalize_result({"PronFluency": 90.2})
    assert pct["fluency"] == pytest.approx(90.2)
    zero = soe_tencent.normalize_result({"PronFluency": 0.0})
    assert zero["fluency"] == 0.0


# ---------------- evaluate 全流程（WS 替身） ----------------


def _fake_wav(data_bytes: int) -> bytes:
    """构造声明了 data 块大小的最小 RIFF/wav 字节（16k/16bit/单声道，32 字节/毫秒）"""
    import struct

    return (
        b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVE"
        + b"fmt " + struct.pack("<I", 16) + b"\x00" * 16
        + b"data" + struct.pack("<I", data_bytes)
    )


def test_wav_duration_ms_chunk_walk():
    """RIFF 块链解析：跳过 LIST 等附加块取 data 块大小换算毫秒；非 wav 返回 0"""
    import struct

    wav = (
        b"RIFF" + struct.pack("<I", 4 + 24 + 14 + 8 + 3200) + b"WAVE"
        + b"fmt " + struct.pack("<I", 16) + b"\x00" * 16
        + b"LIST" + struct.pack("<I", 5) + b"INFOX" + b"\x00"  # 5 字节内容（奇数）+ 块对齐补 1 字节
        + b"data" + struct.pack("<I", 3200)  # 3200 字节 = 100ms
    )
    assert soe_tencent.wav_duration_ms(wav) == 100
    assert soe_tencent.wav_duration_ms(b"RIFF-wav") == 0
    assert soe_tencent.wav_duration_ms(b"") == 0


class FakeWS:
    """脚本化 WS 连接：recv 依序回放消息，send 记录待断言"""

    def __init__(self, script: list):
        """初始化回放脚本（元素为消息或待抛异常）"""
        self._script = list(script)
        self.sent: list = []
        self.closed = False

    async def __aenter__(self):
        """进入连接上下文：返回自身充当 ws 对象"""
        return self

    async def __aexit__(self, *exc):
        """退出连接上下文：记录关闭状态，不吞异常"""
        self.closed = True
        return False

    async def send(self, payload):
        """记录发送帧（binary 音频 / text 结束信号）供测试断言次序"""
        self.sent.append(payload)

    async def recv(self):
        """依序回放下一条消息；脚本元素为异常时抛出；耗尽即测试失败"""
        if not self._script:
            raise AssertionError("脚本消息耗尽（会话未按预期收尾）")
        item = self._script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _patch_media(monkeypatch, tmp_path: Path, *, duration_ms=1000, wav_bytes=None):
    """转码与文件系统替身：extract_audio 写出假 wav（时长可指定），缓存目录指向 tmp"""
    def fake_extract(src, out):
        """替身转码：直接落盘假 wav 字节（不跑真 ffmpeg）"""
        Path(out).write_bytes(wav_bytes if wav_bytes is not None else _fake_wav(duration_ms * 32))
        return out

    monkeypatch.setattr(soe_tencent.ffmpeg, "extract_audio", fake_extract)
    monkeypatch.setattr(soe_tencent, "CACHES_DIR", tmp_path / "caches")


def _result_message(payload: dict) -> str:
    """包装一条 code=0 的 WS 结果消息（result 载荷序列化为字符串字段）"""
    import orjson

    return orjson.dumps({"code": 0, "message": "success", "final": 0, **payload}).decode()


def test_evaluate_happy_path(monkeypatch, tmp_path):
    """正常流：整段 binary + end 文本 → 收 result 与 final=1 → 归一化返回"""
    import orjson

    _patch_media(monkeypatch, tmp_path)
    ws = FakeWS(
        [
            '{"code":0,"message":"success","voice_id":"v1"}',  # 握手
            _result_message({"result": orjson.dumps(_SAMPLE_RESULT).decode()}),
            '{"code":0,"message":"success","voice_id":"v1","final":1}',
        ]
    )
    monkeypatch.setattr(soe_tencent, "ws_connect", lambda url, **kw: ws)
    out = asyncio.run(
        soe_tencent.evaluate(
            "/tmp/a.webm", "hello world",
            endpoint="wss://soe.cloud.tencent.com/soe/api",
            app_id="125000000", secret_id="id", secret_key="key",
        )
    )
    assert out["score"] == pytest.approx(87.5)
    # 发送次序：先整段音频（binary，默认 1s 假 wav），再 end 信号（text）
    assert ws.sent[0] == _fake_wav(1000 * 32)
    assert ws.sent[1] == '{"type": "end"}'
    # 临时 wav 清理
    assert not list((tmp_path / "caches" / "soe").glob("*.wav"))


def test_evaluate_business_error(monkeypatch, tmp_path):
    """业务错误码（4004 资源包耗尽）：抛 SoeError 且文案可读"""
    _patch_media(monkeypatch, tmp_path)
    ws = FakeWS(['{"code":4004,"message":"package exhausted","voice_id":"v1"}'])
    monkeypatch.setattr(soe_tencent, "ws_connect", lambda url, **kw: ws)
    with pytest.raises(soe_tencent.SoeError, match="资源包耗尽"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello world",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )


def test_evaluate_no_result(monkeypatch, tmp_path):
    """final=1 但无 result：明确报「未返回结果」"""
    _patch_media(monkeypatch, tmp_path)
    ws = FakeWS(['{"code":0,"final":1}'])
    monkeypatch.setattr(soe_tencent, "ws_connect", lambda url, **kw: ws)
    with pytest.raises(soe_tencent.SoeError, match="未返回结果"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )


def test_evaluate_ws_rejected(monkeypatch, tmp_path):
    """WSS 握手被拒（HTTP 401，密钥错误的常见面）：包装为可读 SoeError 而非裸 500"""
    from types import SimpleNamespace
    from websockets.exceptions import InvalidStatus

    _patch_media(monkeypatch, tmp_path)

    def rejected(url, **kw):
        """替身连接：握手阶段直接抛 InvalidStatus（服务端 401）"""
        raise InvalidStatus(SimpleNamespace(status_code=401))

    monkeypatch.setattr(soe_tencent, "ws_connect", rejected)
    with pytest.raises(soe_tencent.SoeError, match=r"401.*设置页"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )


def test_evaluate_ws_timeout(monkeypatch, tmp_path):
    """收结果超时（recv 等待 30s 上限）：包装为 SoeError（提示重试）"""
    _patch_media(monkeypatch, tmp_path)
    ws = FakeWS([TimeoutError()])
    monkeypatch.setattr(soe_tencent, "ws_connect", lambda url, **kw: ws)
    with pytest.raises(soe_tencent.SoeError, match="超时"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )


def test_evaluate_ws_network_error(monkeypatch, tmp_path):
    """传输层网络错误（OSError/断连）：包装为可读 SoeError，不逃逸成引擎 500"""
    _patch_media(monkeypatch, tmp_path)

    def boom(url, **kw):
        """替身连接：连接阶段抛 OSError（模拟网络不可达/重置）"""
        raise OSError("connection reset by peer")

    monkeypatch.setattr(soe_tencent, "ws_connect", boom)
    with pytest.raises(soe_tencent.SoeError, match="连接失败"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )


def test_evaluate_too_long_audio(monkeypatch, tmp_path):
    """超 60s 录音：前置拦截，不发起连接"""
    _patch_media(monkeypatch, tmp_path, duration_ms=61_000)
    called = []

    def no_connect(url, **kw):
        called.append(url)
        raise AssertionError("不应发起 WS 连接")

    monkeypatch.setattr(soe_tencent, "ws_connect", no_connect)
    with pytest.raises(soe_tencent.SoeError, match="过长"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )
    assert not called


def test_evaluate_transcode_failure(monkeypatch, tmp_path):
    """ffmpeg 转码失败：包装为 SoeError（消息可展示）"""
    def bad_extract(src, out):
        raise soe_tencent.ffmpeg.MediaError("ffmpeg 缺失")

    monkeypatch.setattr(soe_tencent.ffmpeg, "extract_audio", bad_extract)
    monkeypatch.setattr(soe_tencent, "CACHES_DIR", tmp_path / "caches")
    with pytest.raises(soe_tencent.SoeError, match="转码失败"):
        asyncio.run(
            soe_tencent.evaluate(
                "/tmp/a.webm", "hello",
                endpoint="wss://soe.cloud.tencent.com/soe/api",
                app_id="1", secret_id="i", secret_key="k",
            )
        )
