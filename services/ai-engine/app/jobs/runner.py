"""
任务运行器：引擎内长任务的注册、排队与执行

设计：
- 任务 = {id, type, params, status, progress, message, result, error}
- asyncio.Queue + 单 worker 协程串行消费（GPU 任务天然互斥，符合显存纪律）
- 时间戳口径：epoch 毫秒（与 web 端 jobs 表的 timestamp_ms 列一致，免换算）
- 引擎重启后内存注册表清空；web 端 jobs 表负责持久化与崩溃恢复（回查此 API）
M0 骨架只实现框架与 echo 演示任务；STT/TTS/翻译任务在 M1 接入。
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

# 模块级 logger：任务失败时输出类型化错误与 traceback（无消息异常也能定位）
logger = logging.getLogger(__name__)

# 任务状态常量
QUEUED = "queued"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
CANCELLED = "cancelled"


def _now_ms() -> int:
    """当前时间的 epoch 毫秒（与 web 端 jobs 表 timestamp_ms 口径一致）"""
    return round(time.time() * 1000)


@dataclass
class Job:
    """单个任务的可变状态记录"""

    id: str
    type: str
    params: dict
    status: str = QUEUED
    progress: float = 0.0
    message: str | None = None
    result: Any = None
    error: str | None = None
    created_at: int = field(default_factory=_now_ms)
    started_at: int | None = None
    finished_at: int | None = None
    # 取消标志：任务协程内自行检查并尽快退出
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)


class JobRunner:
    """任务运行器：注册处理器、排队、后台单 worker 执行"""

    def __init__(self) -> None:
        """初始化空的处理器注册表、任务注册表与待执行队列"""
        # 任务类型 → 处理协程函数（params, job）→ result
        self._handlers: dict[str, Callable[[dict, Job], Any]] = {}
        # 内存任务注册表
        self._jobs: dict[str, Job] = {}
        # 待执行任务队列（worker 串行消费）
        self._queue: asyncio.Queue[Job] = asyncio.Queue()
        self._worker_task: asyncio.Task | None = None

    def register(self, job_type: str, handler: Callable[[dict, Job], Any]) -> None:
        """注册某类型任务的处理函数"""
        self._handlers[job_type] = handler

    def submit(self, job_type: str, params: dict) -> Job:
        """提交新任务并入队（未注册的类型立即失败）"""
        if job_type not in self._handlers:
            job = Job(id=str(uuid.uuid4()), type=job_type, params=params)
            job.status = FAILED
            job.error = f"未知任务类型: {job_type}"
            job.finished_at = _now_ms()
            self._jobs[job.id] = job
            return job
        job = Job(id=str(uuid.uuid4()), type=job_type, params=params)
        self._jobs[job.id] = job
        self._queue.put_nowait(job)
        return job

    def get(self, job_id: str) -> Job | None:
        """按 id 查询任务状态"""
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        """请求取消任务（任务内需检查 cancel_event）；未找到返回 False"""
        job = self._jobs.get(job_id)
        if job is None or job.status not in (QUEUED, RUNNING):
            return False
        job.cancel_event.set()
        if job.status == QUEUED:
            job.status = CANCELLED
            job.finished_at = _now_ms()
        return True

    async def start(self) -> None:
        """启动后台 worker 协程（FastAPI lifespan 调用）"""
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        """停止 worker（应用关闭时调用）"""
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
            self._worker_task = None

    async def _worker(self) -> None:
        """串行消费队列：逐个执行任务并记录状态"""
        while True:
            job = await self._queue.get()
            if job.status == CANCELLED:
                continue
            # submit() 已在提交时校验类型注册，此处的 .get 是纵深防御：直接 [type]
            # 索引的 KeyError 会逃出消费循环杀死 worker 协程（fire-and-forget 无人
            # await，start() 也无从重启），此后所有任务永久滞留 QUEUED
            handler = self._handlers.get(job.type)
            if handler is None:
                job.status = FAILED
                job.error = f"未注册的任务类型: {job.type}"
                job.finished_at = _now_ms()
                continue
            job.status = RUNNING
            job.started_at = _now_ms()
            try:
                # 处理器可为协程或普通函数
                result = handler(job.params, job)
                if asyncio.iscoroutine(result):
                    result = await result
                job.result = result
                job.status = CANCELLED if job.cancel_event.is_set() else SUCCEEDED
                job.progress = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 —— 任务级异常不拖垮 worker
                job.status = FAILED
                # 错误带异常类型：无消息异常（如 RuntimeError()）的 str() 为空串，单存会不可诊断
                msg = str(exc)
                job.error = f"{type(exc).__name__}: {msg}" if msg else type(exc).__name__
                logger.exception("任务 %s (%s) 执行失败", job.id, job.type)
            finally:
                job.finished_at = _now_ms()

    def snapshot(self, job: Job) -> dict:
        """任务对象 → API 可返回的字典形态（去掉内部事件对象）

        时间戳一律 epoch 毫秒，与 web 端 jobs 表（timestamp_ms）口径一致。
        """
        return {
            "id": job.id,
            "type": job.type,
            "status": job.status,
            "progress": job.progress,
            "message": job.message,
            "result": job.result,
            "error": job.error,
            "created_at": job.created_at,
            "started_at": job.started_at,
            "finished_at": job.finished_at,
        }


# ---- echo 演示任务：M0 用于验证 web → engine 任务链路连通 ----


async def echo_handler(params: dict, job: Job) -> dict:
    """回显任务：按 params['seconds'] 休眠后原样返回参数（联调链路用）"""
    seconds = float(params.get("seconds", 0.5))
    # 分片休眠以响应取消
    steps = 10
    for i in range(steps):
        if job.cancel_event.is_set():
            return {"cancelled": True}
        await asyncio.sleep(seconds / steps)
        job.progress = (i + 1) / steps
        job.message = f"echo 进度 {i + 1}/{steps}"
    return {"echo": params}
