"""
任务路由：通用长任务 API（创建 / 查询 / 取消）

web 端（编排者）通过此 API 委托引擎执行长任务并轮询进度。
任务本体（STT/TTS/翻译等）在 M1 里程碑逐步注册。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..jobs import JobRunner

router = APIRouter()


class CreateJobRequest(BaseModel):
    """创建任务请求体"""

    # 任务类型（如 echo / stt / tts_batch / translate …）
    type: str
    # 任务参数（随类型而定）
    params: dict = {}


def get_runner() -> JobRunner:
    """从应用状态获取任务运行器单例"""
    from ..main import state  # noqa: PLC0415 —— 避免循环导入，运行时取

    runner: JobRunner | None = state.runner
    if runner is None:
        raise HTTPException(status_code=503, detail="任务运行器未就绪")
    return runner


@router.post("/jobs")
async def create_job(req: CreateJobRequest) -> dict:
    """提交新任务，立即返回任务快照（queued）"""
    runner = get_runner()
    job = runner.submit(req.type, req.params)
    return runner.snapshot(job)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    """查询任务状态（web 端 250ms~1.5s 轮询）"""
    runner = get_runner()
    job = runner.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在或已随引擎重启清除")
    return runner.snapshot(job)


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict:
    """请求取消任务（尽力而为：任务内检查取消标志）"""
    runner = get_runner()
    ok = runner.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail="任务不可取消（不存在或已结束）")
    return {"cancelled": job_id}
