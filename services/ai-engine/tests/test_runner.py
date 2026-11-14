"""
任务运行器测试：时间戳毫秒口径与失败任务的错误信息保真
"""

import asyncio
import time

from app.jobs.runner import FAILED, JobRunner


def test_snapshot_timestamps_are_epoch_ms():
    """snapshot 的时间戳为 epoch 毫秒整数（与 web 端 jobs 表 timestamp_ms 对齐）"""
    runner = JobRunner()
    # 未注册类型立即失败：created_at / finished_at 都会被赋值，无需启动 worker
    job = runner.submit("never-registered", {})
    snap = runner.snapshot(job)
    assert snap["status"] == FAILED
    # 未真正启动的任务 started_at 为 None；created/finished 必须是毫秒整数
    assert snap["started_at"] is None
    now_ms = round(time.time() * 1000)
    for key in ("created_at", "finished_at"):
        value = snap[key]
        assert isinstance(value, int)
        # 落在当前时刻 ±1 天内（毫秒量级；若误用秒会偏小 1000 倍，直接越界）
        assert abs(value - now_ms) < 86_400_000


def test_failed_job_error_includes_exception_type():
    """处理器抛无消息异常：error 含异常类型（不再是可以骗过所有人的空字符串）"""

    async def boom(params: dict, job) -> dict:  # noqa: ARG001
        """必定失败的任务处理器（无消息 RuntimeError）"""
        raise RuntimeError()

    async def scenario() -> dict:
        """驱动一次完整的提交 → 执行 → 终态流程，返回任务快照"""
        runner = JobRunner()
        runner.register("boom", boom)
        job = runner.submit("boom", {})
        await runner.start()
        # 轮询等待终态（不触碰内部属性）
        for _ in range(200):
            if job.status in ("succeeded", "failed", "cancelled"):
                break
            await asyncio.sleep(0.01)
        await runner.stop()
        return runner.snapshot(job)

    snap = asyncio.run(scenario())
    assert snap["status"] == FAILED
    assert snap["error"] == "RuntimeError"
