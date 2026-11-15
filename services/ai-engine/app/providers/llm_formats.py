"""
LLM 多 API 格式适配层：OpenAI Compatible / OpenAI Responses / Anthropic / Gemini

设置页 LLM 档案以「API 格式」区分（存 params.apiFormat，缺省 openai-compatible），
本模块按格式把统一的 messages 形态翻译为各家的请求/响应/SSE 结构：

- openai-compatible: /chat/completions（GLM/DeepSeek/vLLM/LM Studio/Ollama…）
- openai-responses:  /responses（OpenAI 新接口）
- anthropic:         /v1/messages（Claude；system 必须出列、max_tokens 必填）
- gemini:            /models/{m}:generateContent（systemInstruction + role 映射）

各格式的请求三元组 (url, headers, body) 由 *_request 构造器生成，非流式
（chat/chat_json）与流式（chat_stream，产出增量文本的异步生成器）共用同一
构造——供应商怪癖只修一处。HTTP 基础件（客户端/鉴权头/端点规整/宽松 JSON
解析）复用 openai_compat 的公开助手。
"""

import json
from typing import Any, AsyncIterator

import httpx

from . import openai_compat
from .openai_compat import (
    OpenAICompatError,
    auth_headers,
    base_url,
    make_client,
)

# 支持的 API 格式（设置页「API 格式」下拉与此对齐）
FORMATS = ("openai-compatible", "openai-responses", "anthropic", "gemini")

# Anthropic max_tokens 必填。取 4096：claude-3 代各模型输出上限即 4096（更大值
# 会被 API 400 拒绝而非钳制——第三方中转端点常仍在服务这批模型）；claude-4
# 代上限更高不受影响。精听场景的短对话/笔记输出远用不满。
ANTHROPIC_MAX_TOKENS = 4096


def _fmt(api_format: str | None) -> str:
    """规整格式标识：未知/缺省一律回落 openai-compatible（存量档案 paramsJson 为空）"""
    return api_format if api_format in FORMATS else "openai-compatible"


def split_system(messages: list[dict]) -> tuple[str | None, list[dict]]:
    """把 OpenAI 形态 messages 里的 system 条目拆出（Anthropic/Gemini 要求 system 独立传）"""
    system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
    rest = [m for m in messages if m.get("role") != "system"]
    return (system or None), rest


# ---------------- 各格式请求构造器（非流式 / 流式 / 模型清单共用） ----------------


def _anthropic_headers(api_key: str | None) -> dict[str, str]:
    """Anthropic 鉴权头：x-api-key + 版本号（不用 Bearer）"""
    h = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if api_key:
        h["x-api-key"] = api_key
    return h


def _gemini_headers(api_key: str | None) -> dict[str, str]:
    """Gemini 鉴权头：x-goog-api-key（官方推荐，等价 ?key= 查询参数）"""
    h = {"Content-Type": "application/json"}
    if api_key:
        h["x-goog-api-key"] = api_key
    return h


def _anthropic_request(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None,
    stream: bool,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    """构造 Anthropic 请求三元组 (url, headers, body)：system 出列、max_tokens 必填"""
    base = base_url(endpoint_url).removesuffix("/v1")
    system, rest = split_system(messages)
    body: dict[str, Any] = {
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "messages": rest,
    }
    if stream:
        body["stream"] = True
    if system:
        body["system"] = system
    if temperature is not None:
        body["temperature"] = temperature
    return f"{base}/v1/messages", _anthropic_headers(api_key), body


def _gemini_request(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None,
    stream: bool,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    """构造 Gemini 请求三元组 (url, headers, body)：systemInstruction 独立、assistant→model"""
    base = base_url(endpoint_url).removesuffix("/models")
    action = "streamGenerateContent" if stream else "generateContent"
    suffix = "?alt=sse" if stream else ""
    url = f"{base}/models/{model}:{action}{suffix}"
    system, rest = split_system(messages)
    contents = [
        {"role": "model" if m.get("role") == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in rest
    ]
    body: dict[str, Any] = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if temperature is not None:
        body["generationConfig"] = {"temperature": temperature}
    return url, _gemini_headers(api_key), body


def _responses_request(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None,
    stream: bool,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    """构造 OpenAI Responses 请求三元组 (url, headers, body)：messages 原样进 input"""
    body: dict[str, Any] = {"model": model, "input": messages}
    if stream:
        body["stream"] = True
    if temperature is not None:
        body["temperature"] = temperature
    return f"{base_url(endpoint_url)}/responses", auth_headers(api_key), body


# ---------------- 各格式响应聚合（null/异形形状一律兜底为空） ----------------


def _anthropic_text(data: dict) -> str:
    """聚合响应文本：content 列表里的 text 块拼接（content 为 null 时得空串）"""
    blocks = data.get("content") or []
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


def _gemini_text(data: dict) -> str:
    """聚合响应文本：candidates[0].content.parts 的 text 拼接（安全拦截等 null 形状兜底为空）"""
    candidates = data.get("candidates") or [{}]
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    return "".join(p.get("text", "") for p in parts)


def _responses_text(data: dict) -> str:
    """聚合响应文本：output 里 message 项的 output_text 内容拼接（null 字段兜底为空）"""
    out = []
    for item in data.get("output") or []:
        if item.get("type") != "message":
            continue
        for c in item.get("content") or []:
            if c.get("type") == "output_text":
                out.append(c.get("text", ""))
    return "".join(out)


# ---------------- 统一入口：非流式 ----------------


async def chat(
    api_format: str | None,
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None = None,
) -> str:
    """按格式对话补全：统一入参出参（返回 assistant 文本）"""
    fmt = _fmt(api_format)
    if fmt == "openai-compatible":
        return await openai_compat.chat(endpoint_url, api_key, model, messages, temperature=temperature)

    builder = {
        "anthropic": _anthropic_request,
        "gemini": _gemini_request,
    }.get(fmt, _responses_request)
    url, headers, body = builder(
        endpoint_url, api_key, model, messages, temperature=temperature, stream=False
    )
    parse = {"anthropic": _anthropic_text, "gemini": _gemini_text}.get(fmt, _responses_text)
    async with make_client(endpoint_url) as client:
        try:
            r = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"连接云端失败（{endpoint_url}）：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端返回 {r.status_code}：{r.text[:300]}")
    try:
        return parse(r.json())
    # TypeError/AttributeError：安全拦截（content/parts 为 null）等异形但 HTTP 200 的载荷
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise OpenAICompatError(f"云端响应结构异常：{r.text[:300]}") from exc


async def chat_json(
    api_format: str | None,
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None = None,
) -> Any:
    """按格式对话并解析 JSON（剥围栏/修复重试流程与 openai_compat 共用 chat_json_with_retry）"""

    async def call(msgs: list[dict], *, temperature: float | None = None) -> str:
        """绑定格式/端点/密钥/模型的单次对话（供重试流程回调）"""
        return await chat(api_format, endpoint_url, api_key, model, msgs, temperature=temperature)

    return await openai_compat.chat_json_with_retry(call, messages, temperature=temperature)


async def list_models(api_format: str | None, endpoint_url: str, api_key: str | None) -> list[str]:
    """按格式拉取云端模型清单（设置页「获取模型」按钮；各家鉴权头/路径/字段名不同）

    - openai-compatible / openai-responses：GET /models + Bearer（Responses 同源端点）
    - anthropic：GET /v1/models + x-api-key → data[].id
    - gemini：GET /models?pageSize=1000 + x-goog-api-key → models[].name（剥 models/ 前缀）
    Returns:
        模型名列表（保持端点返回顺序）
    Raises:
        OpenAICompatError: 网络/HTTP/响应结构异常
    """
    fmt = _fmt(api_format)
    if fmt == "openai-compatible":
        return await openai_compat.list_models(endpoint_url, api_key)

    if fmt == "anthropic":
        base = base_url(endpoint_url).removesuffix("/v1")
        url, headers = f"{base}/v1/models?limit=100", _anthropic_headers(api_key)
    elif fmt == "gemini":
        base = base_url(endpoint_url).removesuffix("/models")
        url, headers = f"{base}/models?pageSize=100", _gemini_headers(api_key)
    else:  # openai-responses：与 OpenAI 兼容同源的 /models 清单
        url, headers = f"{base_url(endpoint_url)}/models", auth_headers(api_key)

    async with make_client(endpoint_url) as client:
        try:
            r = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"连接云端失败（{endpoint_url}）：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端返回 {r.status_code}：{r.text[:300]}")
    try:
        data = r.json()
        if fmt == "gemini":
            # Gemini 模型名带 models/ 前缀（models/gemini-3-pro）
            return [str(m["name"]).removeprefix("models/") for m in data.get("models") or []]
        return [str(m["id"]) for m in data.get("data") or []]
    except (ValueError, KeyError, TypeError) as exc:
        raise OpenAICompatError(f"云端响应结构异常：{r.text[:300]}") from exc


# ---------------- 统一入口：流式 ----------------


async def chat_stream(
    api_format: str | None,
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None = None,
) -> AsyncIterator[str]:
    """按格式流式对话：逐块产出增量文本（同 openai_compat.chat_stream 约定）"""
    fmt = _fmt(api_format)
    if fmt == "openai-compatible":
        async for piece in openai_compat.chat_stream(
            endpoint_url, api_key, model, messages, temperature=temperature
        ):
            yield piece
        return

    if fmt == "anthropic":

        def take(line_data: str) -> str | None:
            """SSE data JSON → 增量文本（content_block_delta 的 text_delta）"""
            try:
                evt = json.loads(line_data)
            except ValueError:
                return None
            if evt.get("type") == "content_block_delta":
                return (evt.get("delta") or {}).get("text")
            return None

    elif fmt == "gemini":

        def take(line_data: str) -> str | None:  # noqa: F811 —— 分支互斥，同名闭包按格式二选一
            """SSE data JSON → 增量文本（candidates.parts.text 拼接）"""
            try:
                return _gemini_text(json.loads(line_data))
            except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                return None

    else:  # openai-responses

        def take(line_data: str) -> str | None:  # noqa: F811
            """SSE data JSON → 增量文本（response.output_text.delta）"""
            try:
                evt = json.loads(line_data)
            except ValueError:
                return None
            if evt.get("type") == "response.output_text.delta":
                return evt.get("delta")
            return None

    builder = {
        "anthropic": _anthropic_request,
        "gemini": _gemini_request,
    }.get(fmt, _responses_request)
    url, headers, body = builder(
        endpoint_url, api_key, model, messages, temperature=temperature, stream=True
    )
    # 终止靠服务端关闭 SSE 流（各家均有 FIN/连接结束语义，无需解析终止事件）
    client = make_client(endpoint_url)
    try:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code != 200:
                text = (await resp.aread()).decode("utf-8", "replace")
                raise OpenAICompatError(f"云端返回 {resp.status_code}：{text[:300]}")
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                piece = take(payload)
                if piece:
                    yield piece
    except OpenAICompatError:
        raise
    except httpx.HTTPError as exc:
        raise OpenAICompatError(f"流式连接中断：{exc}") from exc
    finally:
        await client.aclose()
