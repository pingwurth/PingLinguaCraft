"""
openai_compat 云端透传测试：模型清单拉取（GET /models）的格式兼容与错误分支、
chat_json_with_retry 共用重试流程

不实际联网：make_client 打补丁为 httpx.MockTransport（handler 直接回构造
响应），覆盖 OpenAI 标准格式、Z.ai 变体、非 200 与非 JSON 四条路径。
"""

import asyncio

import httpx
import pytest

from app.providers import openai_compat


def _patch_client(monkeypatch, handler):
    """把 make_client 替换为走 MockTransport 的工厂（请求 URL 不断言外网）"""

    def factory(endpoint_url: str) -> httpx.AsyncClient:
        """替身客户端工厂：忽略端点，全部请求走 MockTransport"""
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(openai_compat, "make_client", factory)


def test_list_models_openai_format(monkeypatch):
    """OpenAI 标准格式 {data:[{id}]}：全量提取并保持顺序"""

    def handler(request: httpx.Request) -> httpx.Response:
        """断言 /models 路径并回 OpenAI 标准形态"""
        assert request.url.path.endswith("/models")
        return httpx.Response(
            200,
            json={"data": [{"id": "deepseek-chat"}, {"id": "deepseek-reasoner"}]},
        )

    _patch_client(monkeypatch, handler)
    models = asyncio.run(openai_compat.list_models("https://api.deepseek.com/v1", "sk-test"))
    assert models == ["deepseek-chat", "deepseek-reasoner"]


def test_list_models_zai_format(monkeypatch):
    """Z.ai 变体 {models:[{slug}]}：按 slug 提取"""

    def handler(request: httpx.Request) -> httpx.Response:
        """回 Z.ai 变体形态（models/slug 字段名）"""
        return httpx.Response(
            200, json={"models": [{"slug": "glm-5.3"}, {"slug": "glm-5.3-flash"}]}
        )

    _patch_client(monkeypatch, handler)
    models = asyncio.run(openai_compat.list_models("https://open.bigmodel.cn/api/paas/v4", None))
    assert models == ["glm-5.3", "glm-5.3-flash"]


def test_list_models_http_error(monkeypatch):
    """非 200：抛 OpenAICompatError 且消息含状态码"""

    def handler(request: httpx.Request) -> httpx.Response:
        """回 401 模拟鉴权失败"""
        return httpx.Response(401, json={"error": "bad key"})

    _patch_client(monkeypatch, handler)
    with pytest.raises(openai_compat.OpenAICompatError, match="401"):
        asyncio.run(openai_compat.list_models("https://api.example.com/v1", "bad"))


def test_list_models_non_json(monkeypatch):
    """非 JSON 响应：抛 OpenAICompatError"""

    def handler(request: httpx.Request) -> httpx.Response:
        """回 HTML 网关页模拟非 JSON 响应"""
        return httpx.Response(200, text="<html>gateway</html>")

    _patch_client(monkeypatch, handler)
    with pytest.raises(openai_compat.OpenAICompatError, match="不是 JSON"):
        asyncio.run(openai_compat.list_models("https://api.example.com/v1", None))


# ---------------- chat_json_with_retry（openai 兼容与多格式路径共用） ----------------


def test_chat_json_with_retry_repairs_on_second_call():
    """首次输出无 JSON 纯文本、重试输出裸 JSON：修复重试成功解析，回喂消息形态正确
    （围栏 JSON 会被宽松解析直接剥掉，触发不了重试——首输出必须是真无 JSON 的文本）"""
    calls: list[list[dict]] = []

    async def chat_fn(messages, *, temperature=None):  # noqa: ANN001, ARG001
        """记录调用并按次序回「无 JSON 文本 → 裸 JSON」两种输出"""
        calls.append(messages)
        return "好的，结果如下：" if len(calls) == 1 else '{"ok": 2}'

    out = asyncio.run(openai_compat.chat_json_with_retry(chat_fn, [{"role": "user", "content": "给 JSON"}]))
    assert out == {"ok": 2}
    # 重试消息 = 原消息 + assistant 原始输出 + 修复指令
    assert [m["role"] for m in calls[1]] == ["user", "assistant", "user"]
    assert calls[1][1]["content"] == "好的，结果如下："


def test_chat_json_with_retry_fails_after_two_bad_outputs():
    """两次都无法解析：抛 OpenAICompatError（消息含第二次输出片段）"""

    async def chat_fn(messages, *, temperature=None):  # noqa: ANN001, ARG001
        """始终输出非 JSON 文本"""
        return "我不会输出 JSON"

    with pytest.raises(openai_compat.OpenAICompatError, match="两次都未返回合法 JSON"):
        asyncio.run(openai_compat.chat_json_with_retry(chat_fn, [{"role": "user", "content": "给 JSON"}]))


def test_chat_null_content_raises_domain_error(monkeypatch):
    """content 为 null（tool-call-only/截断响应）：转 OpenAICompatError，而非让下游 json.loads(None) 裸 TypeError"""

    def handler(request: httpx.Request) -> httpx.Response:
        """回 tool-call-only 形态：content 为 null"""
        return httpx.Response(200, json={"choices": [{"message": {"content": None}}]})

    _patch_client(monkeypatch, handler)
    with pytest.raises(openai_compat.OpenAICompatError, match="无文本内容"):
        asyncio.run(
            openai_compat.chat("https://x/v1", "k", "m", [{"role": "user", "content": "hi"}])
        )


def test_chat_json_with_retry_survives_none_output():
    """chat_fn 返回 None：TypeError 被修复重试接住，两次失败转领域错误（不再逃逸成裸异常）"""

    async def none_chat(messages, *, temperature=None):  # noqa: ARG001
        """始终返回 None 的对话替身（tool-call-only 病态路径）"""
        return None

    with pytest.raises(openai_compat.OpenAICompatError, match="未返回合法 JSON"):
        asyncio.run(openai_compat.chat_json_with_retry(none_chat, [{"role": "user", "content": "x"}]))
