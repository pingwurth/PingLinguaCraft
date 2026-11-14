"""
PingLinguaCraft 本地 AI 引擎入口（FastAPI）

职责：
- 承载五能力（stt / tts / align / translate / llm）的本地引擎与云端透传（M1 起接入）
- 通用任务 API（长任务排队与进度查询）
- ~/.pinglc/ 目录与 config.json 管理
- 仅监听 127.0.0.1:8765 —— web（Next.js）是唯一调用方，不直接暴露局域网

启动：uv run uvicorn app.main:app --port 8765（或 scripts/engine-setup.sh 后的 start 命令）
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import settings
from .api import jobs as jobs_api
from .api import system as system_api
from .jobs import JobRunner, echo_handler


class AppState:
    """应用级单例容器（任务运行器等）"""

    runner: JobRunner | None = None


state = AppState()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化目录、注册任务、启动 worker；关闭时停止"""
    settings.ensure_dirs()
    runner = JobRunner()
    # M0：注册 echo 联调任务；M1 起注册 stt / tts_batch / translate 等真实任务
    runner.register("echo", echo_handler)
    await runner.start()
    state.runner = runner
    # 预读一次配置，确保 config.json 存在
    settings.load_config()
    yield
    await runner.stop()
    state.runner = None


app = FastAPI(
    title="PingLinguaCraft AI Engine",
    version="0.1.0",
    description="本地 AI 引擎：STT / TTS / 对齐 / 翻译 / LLM 能力路由",
    lifespan=lifespan,
)

# 能力与系统路由（/health /system/*）
app.include_router(system_api.router)
# 任务路由（/jobs CRUD）
app.include_router(jobs_api.router)
