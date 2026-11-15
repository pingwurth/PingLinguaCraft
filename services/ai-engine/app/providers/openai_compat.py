"""
OpenAI 兼容云端透传客户端

一个模块覆盖所有云端能力（LLM 对话 / 翻译 / 云端 STT / 云端 TTS）：
GLM、DeepSeek、GPT、Qwen、MIMO、本地 hy-MT2 等 OpenAI 兼容端点
只需在请求里携带 {endpoint_url, api_key, model}，无需任何专门代码。

设计约束：
- 引擎不落库、不缓存云端凭据 —— profile 由 web 端 provider_profiles 表解析后随请求传入
- 统一 120s 超时（LLM 长文/翻译批可能较慢；单用户自托管无并发压力）
- 结构化输出（JSON）带「剥代码围栏 + 修复重试」：云端模型爱用 ```json 围栏
"""

import json
import re
from typing import Any, Awaitable, Callable

import httpx

# 云端请求统一超时（秒）
TIMEOUT = httpx.Timeout(120.0, connect=15.0)


class OpenAICompatError(RuntimeError):
    """云端透传失败（网络/鉴权/响应格式），携带可直接展示给用户的消息"""


def make_client(endpoint_url: str) -> httpx.AsyncClient:
    """按端点构造客户端：本机回环地址直连（绕过系统 SOCKS/HTTP 代理），
    远端端点尊重代理环境变量（国内访问 OpenAI 等常需代理）"""
    from urllib.parse import urlparse  # noqa: PLC0415

    host = urlparse(endpoint_url).hostname or ""
    is_local = host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")
    return httpx.AsyncClient(timeout=TIMEOUT, trust_env=not is_local)


def auth_headers(api_key: str | None) -> dict[str, str]:
    """构造请求头：有 Key 走 Bearer，无 Key 也放行（本地 vLLM/Ollama 常免鉴权）"""
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def base_url(endpoint_url: str) -> str:
    """规整端点：去尾部斜杠；容错用户填了完整 API 路径的情况"""
    base = endpoint_url.rstrip("/")
    # 用户直接粘贴了 .../chat/completions —— 剥掉，路径由各格式构造器统一拼接
    # （/responses 是 OpenAI Responses 格式的专属路径，同样剥）
    for suffix in ("/chat/completions", "/audio/transcriptions", "/audio/speech", "/responses"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return base


async def chat(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> str:
    """对话补全：发 messages，返回 assistant 文本内容

    Args:
        endpoint_url: OpenAI 兼容端点（……/v1 形式即可）
        api_key:      Bearer 令牌（可空，本地端点常免鉴权）
        model:        模型名
        messages:     OpenAI 消息数组（system/user/assistant）
        temperature:  采样温度（None=服务端默认）
        max_tokens:   上限（None=服务端默认）
    Returns:
        assistant 回复文本
    Raises:
        OpenAICompatError: 网络/HTTP/响应结构异常
    """
    body: dict[str, Any] = {"model": model, "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    url = f"{base_url(endpoint_url)}/chat/completions"
    async with make_client(endpoint_url) as client:
        try:
            r = await client.post(url, json=body, headers=auth_headers(api_key))
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"连接云端失败（{endpoint_url}）：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端返回 {r.status_code}：{r.text[:300]}")
    try:
        content = r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        raise OpenAICompatError(f"云端响应结构异常：{r.text[:300]}") from exc
    # content 合法可为 null（tool-call-only / 被截断的响应）：直接返回会让下游
    # json.loads(None) 抛 TypeError、逃过 chat_json_with_retry 的修复重试——
    # 在此转为领域错误
    if not isinstance(content, str):
        raise OpenAICompatError(f"云端响应无文本内容（tool-call-only 或被截断？）：{r.text[:300]}")
    return content


async def chat_json_with_retry(
    chat_fn: Callable[..., Awaitable[str]],
    messages: list[dict],
    *,
    temperature: float | None = None,
) -> Any:
    """「对话 → 宽松 JSON 解析 → 修复重试一次」共用流程

    openai_compat.chat_json（OpenAI 兼容路径）与 llm_formats.chat_json
    （anthropic/gemini/responses 路径）此前各持一份逐行相同的实现，重试
    契约（修复提示词、次数、失败文案）在此单一来源。

    Args:
        chat_fn:     单次对话可调用 (messages, *, temperature) → assistant 文本
        messages:    原始消息数组（重试时在其后追加错误回喂两条）
        temperature: 采样温度
    Returns:
        解析后的 JSON 对象（dict/list 等）
    Raises:
        OpenAICompatError: 两次输出都无法解析为 JSON
    """
    text = await chat_fn(messages, temperature=temperature)
    try:
        return loads_lenient(text)
    # TypeError 一并接住：chat_fn 返回 None（tool-call-only 响应）时 json.loads(None)
    # 抛 TypeError 而非 ValueError，不接住会逃过修复重试直接裸异常到调用方
    except (ValueError, TypeError):
        pass
    # 修复重试：把原始输出与错误回喂，要求「只输出合法 JSON」
    retry_messages = messages + [
        {"role": "assistant", "content": text},
        {
            "role": "user",
            "content": "上面的输出不是合法 JSON。请只输出合法 JSON（不要任何解释、不要代码围栏）。",
        },
    ]
    text2 = await chat_fn(retry_messages, temperature=temperature)
    try:
        return loads_lenient(text2)
    except (ValueError, TypeError) as exc:
        # text2 可能为 None（tool-call-only 响应），错误消息构造须 None 安全
        raise OpenAICompatError(f"模型两次都未返回合法 JSON：{(text2 or '')[:200]}") from exc


async def chat_json(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None = None,
) -> Any:
    """对话并解析 JSON 结果：剥 ```json 围栏；解析失败自动带错误重试一次

    Returns:
        解析后的 JSON 对象（dict/list 等）
    """

    async def call(msgs: list[dict], *, temperature: float | None = None) -> str:
        """绑定端点/密钥/模型的单次对话（供 chat_json_with_retry 回调）"""
        return await chat(endpoint_url, api_key, model, msgs, temperature=temperature)

    return await chat_json_with_retry(call, messages, temperature=temperature)


async def list_models(endpoint_url: str, api_key: str | None) -> list[str]:
    """拉取云端模型清单（GET /models）：设置页「获取模型」按钮的数据源

    兼容两种返回形态（字段名不同、结构同类）：
    - OpenAI 标准：{data: [{id: "gpt-5"}, …]}（DeepSeek / vLLM / LM Studio 等）
    - Z.ai 变体：  {models: [{slug: "glm-5.3"}, …]}（智谱新入口）

    Args:
        endpoint_url: OpenAI 兼容端点（……/v1 形式即可）
        api_key:      Bearer 令牌（可空，本地端点常免鉴权）
    Returns:
        模型名列表（保持端点返回顺序）
    Raises:
        OpenAICompatError: 网络/HTTP/响应结构异常
    """
    url = f"{base_url(endpoint_url)}/models"
    async with make_client(endpoint_url) as client:
        try:
            r = await client.get(url, headers=auth_headers(api_key))
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"连接云端失败（{endpoint_url}）：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端返回 {r.status_code}：{r.text[:300]}")
    try:
        data = r.json()
    except ValueError as exc:
        raise OpenAICompatError(f"云端响应不是 JSON：{r.text[:200]}") from exc
    items = data.get("data") or data.get("models") or []
    models = [
        m
        for m in (
            (it.get("id") or it.get("slug")) if isinstance(it, dict) else None
            for it in items
        )
        if m
    ]
    return models


def loads_lenient(text: str) -> Any:
    """宽松 JSON 解析：直接解析 → 剥围栏解析 → 抓取首个 {...}/[...] 平衡块"""
    try:
        return json.loads(text)
    except ValueError:
        pass
    # 剥 ```json ... ``` 围栏
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1))
    # 抓首个平衡的 JSON 块（模型在 JSON 前后加了解释文字时）
    start = next((i for i, c in enumerate(text) if c in "{["), None)
    if start is not None:
        opener = text[start]
        closer = "}" if opener == "{" else "]"
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    return json.loads(text[start : i + 1])
    raise ValueError("无 JSON 内容")


async def transcribe(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    audio_path: str,
    *,
    language: str | None = None,
) -> str:
    """云端语音转写（audio/transcriptions）：整文件上传，返回纯文本

    说明：OpenAI 兼容转写接口不保证词级时间戳，云端 STT 档案仅作兜底；
    精听场景的词级时间戳以本地 faster-whisper 为准。
    """
    url = f"{base_url(endpoint_url)}/audio/transcriptions"
    async with make_client(endpoint_url) as client:
        try:
            with open(audio_path, "rb") as f:
                files = {"file": (audio_path.rsplit("/", 1)[-1], f)}
                data: dict[str, str] = {"model": model}
                if language:
                    data["language"] = language
                r = await client.post(
                    url, files=files, data=data, headers=auth_headers(api_key)
                )
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"上传云端转写失败：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端转写返回 {r.status_code}：{r.text[:300]}")
    try:
        return r.json()["text"]
    except (KeyError, ValueError):
        return r.text


async def chat_stream(
    endpoint_url: str,
    api_key: str | None,
    model: str,
    messages: list[dict],
    *,
    temperature: float | None = None,
):
    """流式对话：逐块产出增量文本（OpenAI SSE 协议，delta.content）

    用作异步生成器：async for chunk in chat_stream(...) —— 引擎以 SSE 透传给 web。
    网络错误在首个块前抛 OpenAICompatError；中途断流以 [断流] 增量收尾（UI 可见）。
    """
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    if temperature is not None:
        body["temperature"] = temperature
    url = f"{base_url(endpoint_url)}/chat/completions"
    client = make_client(endpoint_url)
    try:
        async with client.stream("POST", url, json=body, headers=auth_headers(api_key)) as resp:
            if resp.status_code != 200:
                text = (await resp.aread()).decode("utf-8", "replace")
                raise OpenAICompatError(f"云端返回 {resp.status_code}：{text[:300]}")
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    if payload == "[DONE]":
                        return
                    continue
                try:
                    delta = json.loads(payload)["choices"][0]["delta"]
                except (ValueError, KeyError, IndexError):
                    continue
                piece = delta.get("content")
                if piece:
                    yield piece
    except OpenAICompatError:
        raise
    except httpx.HTTPError as exc:
        raise OpenAICompatError(f"流式连接中断：{exc}") from exc
    finally:
        await client.aclose()
