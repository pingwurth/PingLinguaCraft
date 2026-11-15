"""
阿里云原生 API 适配测试：URL/WS 地址推导 / apiPath 归一 / STT 新协议
（input_audio + SSE disable + sentence 词级时间戳解析）/ TTS 默认值与守卫

STT 不实际联网：make_client 打补丁为 httpx.MockTransport；TTS WebSocket 循环
属 IO 集成路径，单测只覆盖纯函数与入参守卫（真实链路由端到端冒烟覆盖）。
"""

import asyncio
import json

import httpx
import pytest

from app import settings
from app.providers import aliyun_native, openai_compat


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """缓存目录指到临时 PINGLC_HOME（合成缓存的读写不落真实 ~/.pinglc）"""
    home = tmp_path / "pinglc-home"
    monkeypatch.setattr(settings, "PINGLC_HOME", home)
    monkeypatch.setattr(settings, "CACHES_DIR", home / "caches")
    return home


def _patch_client(monkeypatch, handler):
    """把 make_client 替换为走 MockTransport 的工厂（请求 URL 不断言外网）"""

    def factory(endpoint_url: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(openai_compat, "make_client", factory)
    monkeypatch.setattr(aliyun_native, "make_client", factory)


def test_full_url():
    """URL 拼接：端点尾斜杠与路径前导斜杠的冗余组合都归一"""
    assert (
        aliyun_native.full_url("https://x.aliyuncs.com/", "/api/v1/services/a/b")
        == "https://x.aliyuncs.com/api/v1/services/a/b"
    )


def test_ws_url():
    """端点 URL → WebSocket 合成地址（取 netloc，路径无关）"""
    assert (
        aliyun_native.ws_url("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")
        == "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
    )
    with pytest.raises(openai_compat.OpenAICompatError):
        aliyun_native.ws_url("not-a-url")


def test_transcribe_protocol_and_parse(monkeypatch, tmp_path):
    """STT：input_audio data URL 内嵌、SSE disable 头、parameters 声明格式；
    响应 sentence.words 的毫秒时间戳转秒"""
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF-fake-wav")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/api/v1/services/aigc/multimodal-generation/generation")
        assert request.headers["X-DashScope-SSE"] == "disable"
        assert request.headers["Authorization"] == "Bearer sk-test"
        body = json.loads(request.content)
        assert body["model"] == "qwen-audio-3.0-asr-flash"
        assert body["parameters"] == {"format": "wav", "sample_rate": "16000"}
        content = body["input"]["messages"][0]["content"]
        assert content[0]["type"] == "input_audio"
        assert content[0]["input_audio"]["data"].startswith("data:audio/wav;base64,")
        return httpx.Response(200, json={"sentence": {
            "text": " Hello world. ",
            "words": [
                {"begin_time": 280, "end_time": 520, "text": " Hello"},
                {"begin_time": 520, "end_time": 900, "text": " world."},
                {"begin_time": 900, "end_time": 950, "text": "  "},  # 空白词条应被过滤
            ]}})

    _patch_client(monkeypatch, handler)
    result = asyncio.run(
        aliyun_native.transcribe(
            "https://x.aliyuncs.com", "sk-test", "qwen-audio-3.0-asr-flash", str(audio),
            api_path="/api/v1/services/aigc/multimodal-generation/generation",
        )
    )
    assert result["text"] == "Hello world."
    assert result["words"] == [
        {"w": "Hello", "s": 0.28, "e": 0.52},
        {"w": "world.", "s": 0.52, "e": 0.9},
    ]


def test_transcribe_oversize_guard(monkeypatch, tmp_path):
    """STT：超过内嵌上限直接报错（不发起请求）"""
    audio = tmp_path / "big.wav"
    audio.write_bytes(b"x" * (aliyun_native.MAX_AUDIO_BYTES + 1))

    _patch_client(monkeypatch, lambda request: httpx.Response(200))  # 不应被调用
    with pytest.raises(openai_compat.OpenAICompatError, match="音频过大"):
        asyncio.run(
            aliyun_native.transcribe("https://x.aliyuncs.com", "sk", "m", str(audio), api_path="/p")
        )


def test_synthesize_guards(isolated):
    """TTS：空文本 / 缺 Key 的入参守卫（WebSocket 前置检查）"""
    with pytest.raises(openai_compat.OpenAICompatError, match="文本为空"):
        asyncio.run(aliyun_native.synthesize("https://x.aliyuncs.com", "sk", "m", "  "))
    with pytest.raises(openai_compat.OpenAICompatError, match="API Key"):
        asyncio.run(aliyun_native.synthesize("https://x.aliyuncs.com", None, "m", "hi"))
