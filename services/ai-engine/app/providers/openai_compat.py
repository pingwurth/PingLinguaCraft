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
from typing import Any

import httpx

# 云端请求统一超时（秒）
TIMEOUT = httpx.Timeout(120.0, connect=15.0)


class OpenAICompatError(RuntimeError):
    """云端透传失败（网络/鉴权/响应格式），携带可直接展示给用户的消息"""


def _make_client(endpoint_url: str) -> httpx.AsyncClient:
    """按端点构造客户端：本机回环地址直连（绕过系统 SOCKS/HTTP 代理），
    远端端点尊重代理环境变量（国内访问 OpenAI 等常需代理）"""
    from urllib.parse import urlparse  # noqa: PLC0415

    host = urlparse(endpoint_url).hostname or ""
    is_local = host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")
    return httpx.AsyncClient(timeout=TIMEOUT, trust_env=not is_local)


def _headers(api_key: str | None) -> dict[str, str]:
    """构造请求头：有 Key 走 Bearer，无 Key 也放行（本地 vLLM/Ollama 常免鉴权）"""
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


def _base(endpoint_url: str) -> str:
    """规整端点：去尾部斜杠；容错用户填了完整 chat 路径的情况"""
    base = endpoint_url.rstrip("/")
    # 用户直接粘贴了 .../chat/completions —— 剥掉，路径由本模块统一拼接
    for suffix in ("/chat/completions", "/audio/transcriptions", "/audio/speech"):
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
    url = f"{_base(endpoint_url)}/chat/completions"
    async with _make_client(endpoint_url) as client:
        try:
            r = await client.post(url, json=body, headers=_headers(api_key))
        except httpx.HTTPError as exc:
            raise OpenAICompatError(f"连接云端失败（{endpoint_url}）：{exc}") from exc
    if r.status_code != 200:
        raise OpenAICompatError(f"云端返回 {r.status_code}：{r.text[:300]}")
    try:
        return r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError) as exc:
        raise OpenAICompatError(f"云端响应结构异常：{r.text[:300]}") from exc


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
    url = _base(endpoint_url)
    text = await chat(
        url, api_key, model, messages, temperature=temperature
    )
    try:
        return _loads_lenient(text)
    except ValueError:
        pass
    # 修复重试：把原始输出与错误回喂，要求「只输出合法 JSON」
    retry_messages = messages + [
        {"role": "assistant", "content": text},
        {
            "role": "user",
            "content": "上面的输出不是合法 JSON。请只输出合法 JSON（不要任何解释、不要代码围栏）。",
        },
    ]
    text2 = await chat(url, api_key, model, retry_messages, temperature=temperature)
    try:
        return _loads_lenient(text2)
    except ValueError as exc:
        raise OpenAICompatError(f"模型两次都未返回合法 JSON：{text2[:200]}") from exc


def _loads_lenient(text: str) -> Any:
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
    url = f"{_base(endpoint_url)}/audio/transcriptions"
    async with _make_client(endpoint_url) as client:
        try:
            with open(audio_path, "rb") as f:
                files = {"file": (audio_path.rsplit("/", 1)[-1], f)}
                data: dict[str, str] = {"model": model}
                if language:
                    data["language"] = language
                r = await client.post(
                    url, files=files, data=data, headers=_headers(api_key)
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
    url = f"{_base(endpoint_url)}/chat/completions"
    client = _make_client(endpoint_url)
    try:
        async with client.stream("POST", url, json=body, headers=_headers(api_key)) as resp:
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
