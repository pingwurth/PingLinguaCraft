"""
llm_formats 多 API 格式适配测试：Anthropic / Gemini / OpenAI Responses 的
请求构造（URL/头/system 拆分/角色映射）与响应聚合、流式增量提取、格式回落、
异形载荷（安全拦截等 null 形状）兜底。

不实际联网：make_client 打补丁为 httpx.MockTransport，handler 断言请求并回构造响应。
"""

import asyncio
import json

import httpx

from app.providers import llm_formats


def _patch_client(monkeypatch, handler):
    """把 make_client 替换为走 MockTransport 的工厂"""

    def factory(endpoint_url: str) -> httpx.AsyncClient:
        """替身客户端工厂：忽略端点，全部请求走 MockTransport"""
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(llm_formats, "make_client", factory)


def _run(coro):
    """同步驱动异步函数（工程内测试惯例，见 test_runner）"""
    return asyncio.run(coro)


# ---------------- 非流式：请求构造与响应聚合 ----------------


def test_anthropic_chat(monkeypatch):
    """Anthropic：system 出列、max_tokens 必填、x-api-key 头、content 文本聚合"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言请求形态并回带双 text 块的响应"""
        assert request.url.path.endswith("/v1/messages")
        assert request.headers["x-api-key"] == "sk-ant"
        assert request.headers["anthropic-version"]
        body = json.loads(request.content)
        assert body["system"] == "你是翻译官"
        # 4096：claude-3 代输出上限（更大值被 400 拒绝而非钳制）
        assert body["max_tokens"] == llm_formats.ANTHROPIC_MAX_TOKENS == 4096
        assert [m["role"] for m in body["messages"]] == ["user"]
        return httpx.Response(
            200,
            json={"content": [{"type": "text", "text": "你好"}, {"type": "text", "text": "世界"}]},
        )

    _patch_client(monkeypatch, handler)
    msgs = [
        {"role": "system", "content": "你是翻译官"},
        {"role": "user", "content": "hello world"},
    ]
    out = _run(llm_formats.chat("anthropic", "https://api.anthropic.com", "sk-ant", "claude-5-sonnet", msgs))
    assert out == "你好世界"


def test_anthropic_null_content(monkeypatch):
    """Anthropic 空载荷：HTTP 200 但 content 为 null（拒绝回答等）→ 得空串而非异常"""

    def handler(request: httpx.Request) -> httpx.Response:
        """回 content=null 的响应（异形但 200）"""
        return httpx.Response(200, json={"content": None})

    _patch_client(monkeypatch, handler)
    out = _run(llm_formats.chat("anthropic", "https://api.anthropic.com", "k", "claude-5-sonnet", [{"role": "user", "content": "hi"}]))
    assert out == ""


def test_gemini_chat(monkeypatch):
    """Gemini：systemInstruction 独立、assistant→model 角色映射、parts 文本聚合"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言请求形态并回带双 parts 的响应"""
        assert request.url.path.endswith(":generateContent")
        assert request.headers["x-goog-api-key"] == "g-key"
        body = json.loads(request.content)
        assert body["systemInstruction"]["parts"][0]["text"] == "你是老师"
        assert [c["role"] for c in body["contents"]] == ["user", "model", "user"]
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": "答案"}, {"text": "如下"}]}}]},
        )

    _patch_client(monkeypatch, handler)
    msgs = [
        {"role": "system", "content": "你是老师"},
        {"role": "user", "content": "问"},
        {"role": "assistant", "content": "答"},
        {"role": "user", "content": "再问"},
    ]
    out = _run(llm_formats.chat("gemini", "https://generativelanguage.googleapis.com/v1beta", "g-key", "gem-3-pro", msgs))
    assert out == "答案如下"


def test_gemini_safety_blocked(monkeypatch):
    """Gemini 安全拦截：200 但 content=null（finishReason=SAFETY）→ 空串而非 AttributeError"""

    def handler(request: httpx.Request) -> httpx.Response:
        """回安全拦截形态的响应（candidates[0].content 为 null）"""
        return httpx.Response(
            200,
            json={"candidates": [{"content": None, "finishReason": "SAFETY"}]},
        )

    _patch_client(monkeypatch, handler)
    out = _run(llm_formats.chat("gemini", "https://generativelanguage.googleapis.com/v1beta", "k", "gem-3-pro", [{"role": "user", "content": "hi"}]))
    assert out == ""


def test_responses_chat(monkeypatch):
    """OpenAI Responses：input 直传、output 里的 output_text 聚合"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言 input 形态并回带混杂 output 项的响应"""
        assert request.url.path.endswith("/responses")
        body = json.loads(request.content)
        assert body["input"] == [{"role": "user", "content": "hi"}]
        return httpx.Response(
            200,
            json={
                "output": [
                    {"type": "reasoning"},
                    {"type": "message", "content": [{"type": "output_text", "text": "好"}]},
                    {"type": "message", "content": [{"type": "output_text", "text": "的"}]},
                ]
            },
        )

    _patch_client(monkeypatch, handler)
    out = _run(llm_formats.chat("openai-responses", "https://api.openai.com/v1", "sk", "gpt-5", [{"role": "user", "content": "hi"}]))
    assert out == "好的"


def test_unknown_format_falls_back_to_compatible(monkeypatch):
    """未知/缺省格式回落 OpenAI 兼容（走 openai_compat.chat，断言其请求形态）"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言回落路径的 chat/completions 请求"""
        assert request.url.path.endswith("/chat/completions")
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    _patch_client(monkeypatch, handler)
    # _patch_client 补的是 llm_formats.make_client；回落路径调 openai_compat.chat，
    # 其内部用自己的 make_client——同样打补丁保证不联网
    monkeypatch.setattr(
        "app.providers.openai_compat.make_client",
        lambda endpoint_url: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    out = _run(llm_formats.chat(None, "https://api.deepseek.com/v1", "sk", "deepseek-chat", [{"role": "user", "content": "hi"}]))
    assert out == "ok"


# ---------------- 模型清单（按格式分发：鉴权头/路径/字段名各不同） ----------------


def test_list_models_anthropic(monkeypatch):
    """Anthropic：GET /v1/models + x-api-key → data[].id 提取"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言 anthropic 鉴权头并回标准形态"""
        assert request.url.path.endswith("/v1/models")
        assert request.headers["x-api-key"] == "sk-ant"
        assert request.headers["anthropic-version"]
        return httpx.Response(200, json={"data": [{"id": "claude-5-sonnet"}, {"id": "claude-5-haiku"}]})

    _patch_client(monkeypatch, handler)
    models = _run(llm_formats.list_models("anthropic", "https://api.anthropic.com", "sk-ant"))
    assert models == ["claude-5-sonnet", "claude-5-haiku"]


def test_list_models_gemini(monkeypatch):
    """Gemini：GET /models + x-goog-api-key → models[].name 剥 models/ 前缀"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言 gemini 鉴权头并回带前缀的模型名"""
        assert request.url.path.endswith("/models")
        assert request.headers["x-goog-api-key"] == "g-key"
        return httpx.Response(
            200, json={"models": [{"name": "models/gemini-3-pro"}, {"name": "models/gemini-3-flash"}]}
        )

    _patch_client(monkeypatch, handler)
    models = _run(llm_formats.list_models("gemini", "https://generativelanguage.googleapis.com/v1beta", "g-key"))
    assert models == ["gemini-3-pro", "gemini-3-flash"]


def test_list_models_compatible_delegates(monkeypatch):
    """openai-compatible/缺省格式：回落 openai_compat.list_models（OpenAI 方言）"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言 Bearer 头与 /models 路径"""
        assert request.headers["authorization"] == "Bearer sk"
        return httpx.Response(200, json={"data": [{"id": "glm-5.3"}]})

    monkeypatch.setattr(
        "app.providers.openai_compat.make_client",
        lambda endpoint_url: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    models = _run(llm_formats.list_models(None, "https://open.bigmodel.cn/api/paas/v4", "sk"))
    assert models == ["glm-5.3"]


# ---------------- 流式：增量提取 ----------------


def _sse(lines: list[str]) -> bytes:
    """拼 SSE 字节流（data: 行 + 空行分隔）"""
    return ("\n".join(lines) + "\n").encode()


def test_anthropic_stream(monkeypatch):
    """Anthropic 流式：content_block_delta 的 text_delta 增量，其它事件忽略"""
    body = _sse([
        'data: {"type":"message_start"}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}',
        'data: {"type":"message_stop"}',
    ])

    def handler(request: httpx.Request) -> httpx.Response:
        """断言 stream=True 并回放 SSE 事件序列"""
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    _patch_client(monkeypatch, handler)
    out = []

    async def collect():
        """收集全部流式增量到外层 out 列表"""
        async for piece in llm_formats.chat_stream("anthropic", "https://api.anthropic.com", "k", "claude-5-sonnet", [{"role": "user", "content": "hi"}]):
            out.append(piece)

    _run(collect())
    assert out == ["你", "好"]


def test_gemini_stream(monkeypatch):
    """Gemini 流式：streamGenerateContent 端点 + candidates.parts 增量"""
    body = _sse([
        'data: {"candidates":[{"content":{"parts":[{"text":"早"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"上好"}]}}]}',
    ])

    def handler(request: httpx.Request) -> httpx.Response:
        """断言流式端点与 alt=sse 并回放增量"""
        assert ":streamGenerateContent" in request.url.path
        assert "alt=sse" in str(request.url)
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    _patch_client(monkeypatch, handler)
    out = []

    async def collect():
        """收集全部流式增量到外层 out 列表"""
        async for piece in llm_formats.chat_stream("gemini", "https://generativelanguage.googleapis.com/v1beta", "k", "gem-3-pro", [{"role": "user", "content": "hi"}]):
            out.append(piece)

    _run(collect())
    assert out == ["早", "上好"]


def test_responses_stream(monkeypatch):
    """OpenAI Responses 流式：response.output_text.delta 增量，completed 事件忽略"""
    body = _sse([
        'data: {"type":"response.output_text.delta","delta":"你好"}',
        'data: {"type":"response.completed"}',
    ])

    def handler(request: httpx.Request) -> httpx.Response:
        """回放 delta 与终止事件混合的 SSE 流"""
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    _patch_client(monkeypatch, handler)
    out = []

    async def collect():
        """收集全部流式增量到外层 out 列表"""
        async for piece in llm_formats.chat_stream("openai-responses", "https://api.openai.com/v1", "sk", "gpt-5", [{"role": "user", "content": "hi"}]):
            out.append(piece)

    _run(collect())
    assert out == ["你好"]
