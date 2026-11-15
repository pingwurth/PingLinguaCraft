"""
WebSocket 会话脚手架（云端适配器共用：阿里云 TTS 实时合成 / 腾讯云 SOE 口语评测）

两个适配器此前各自手搓同一套 connect + 限时 recv + 传输层异常梯子，且梯子里
藏着一个 Python 3.11+ 陷阱：TimeoutError 是 OSError 的子类，except 顺序颠倒
会把「响应超时」误报成「连接失败」。收敛到本模块后，超时策略/异常顺序/
握手拒绝的处理只修一处。

用法（领域异常由 error 工厂参数化）：
    async with WsSession(url, error=SoeError, label="评测服务", recv_timeout=30) as ws:
        await ws.send(data)
        raw = await ws.recv()   # 超时/断连/网络错误自动包装为领域异常上抛
"""

import asyncio
from typing import Callable
from urllib.parse import urlsplit

import websockets
from websockets.exceptions import InvalidStatus, WebSocketException

# 单帧/单消息体积上限（与两个适配器旧实现一致：音频二进制帧可达 MB 级）
_MAX_SIZE = 8 * 1024 * 1024


class WsSession:
    """websockets 连接包装：限时收发 + 传输层异常归一为领域错误

    Attributes:
        error:  单参工厂（消息 → 领域异常，如 SoeError / OpenAICompatError），
                适配器自定义异常类型由此注入，本模块不依赖任何适配器
        label:  错误文案里的服务名前缀（如「评测服务」「云端合成」）
    """

    def __init__(
        self,
        url: str,
        *,
        error: Callable[[str], Exception],
        label: str,
        headers: dict[str, str] | None = None,
        open_timeout: float = 10.0,
        close_timeout: float = 5.0,
        recv_timeout: float = 30.0,
    ) -> None:
        """注册连接参数（真正建连在 __aenter__）

        Args:
            url:          完整 wss 地址（含鉴权参数/签名 query）
            error:        领域异常工厂 str → Exception
            label:        错误文案服务名（如「评测服务」）
            headers:      握手附加头（如 Authorization: bearer …）
            open_timeout: 握手超时秒数
            close_timeout: 关闭握手超时秒数（final 消息后服务端要求客户端主动断开）
            recv_timeout: 单次 recv 等待上限秒数
        """
        self._url = url
        self._error = error
        self._label = label
        self._headers = headers
        self._open_timeout = open_timeout
        self._close_timeout = close_timeout
        self._recv_timeout = recv_timeout
        self._ws = None

    def _safe_url(self) -> str:
        """错误文案用的脱敏 URL（仅 scheme://netloc/path）

        完整 URL 绝不进错误信息——SOE 的 query 里带 secretid/HMAC 签名/nonce，
        错误会经 SoeError → HTTP 502 detail 与任务路径的 job.error（web 落
        jobs 表并在页面渲染）外泄，违反「凭据只在服务端」的约定。
        """
        parts = urlsplit(self._url)
        return f"{parts.scheme}://{parts.netloc}{parts.path}"

    async def __aenter__(self) -> "WsSession":
        """建立连接；握手被拒（HTTP 层，多为凭据/地址错误）与网络错误包装为领域异常"""
        try:
            self._ws = await websockets.connect(
                self._url,
                open_timeout=self._open_timeout,
                close_timeout=self._close_timeout,
                max_size=_MAX_SIZE,
                additional_headers=self._headers or {},
            )
        except InvalidStatus as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            # 401/403 基本是凭据或地址问题——直接给出排查方向
            hint = "：多为凭据或服务地址有误，请到设置页检查" if status in (401, 403) else ""
            raise self._error(f"{self._label}拒绝连接（HTTP {status if status is not None else '?'}）{hint}") from exc
        except (WebSocketException, OSError) as exc:
            raise self._error(f"{self._label}连接失败（{self._safe_url()}）：{exc}") from exc
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        """关闭连接（final=1 后服务端要求客户端主动断开；关闭失败吞掉，绝不掩盖正上抛的业务异常）"""
        if self._ws is not None:
            try:
                await self._ws.close()
            except (WebSocketException, OSError):
                pass

    async def send(self, data: "str | bytes") -> None:
        """发送一帧（text 或 binary）；传输层异常包装为领域异常"""
        try:
            await self._ws.send(data)
        except (WebSocketException, OSError) as exc:
            raise self._error(f"{self._label}连接中断：{exc}") from exc

    async def recv(self) -> "str | bytes":
        """限时收一帧；超时/断连/网络错误包装为领域异常

        注意 except 顺序：TimeoutError 必须先于 (WebSocketException, OSError)
        捕获——Python 3.11+ 里它是 OSError 子类，顺序颠倒会把超时误报成连接失败。
        """
        try:
            return await asyncio.wait_for(self._ws.recv(), timeout=self._recv_timeout)
        except asyncio.TimeoutError as exc:
            raise self._error(f"{self._label}响应超时（{self._recv_timeout:.0f}s），请重试") from exc
        except (WebSocketException, OSError) as exc:
            raise self._error(f"{self._label}连接中断：{exc}") from exc
