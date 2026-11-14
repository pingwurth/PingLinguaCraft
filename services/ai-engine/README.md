# PingLinguaCraft AI Engine（本地 AI 引擎）

FastAPI 服务，承载 STT / TTS / 音素对齐 / 翻译 / LLM 五种能力的本地引擎与云端透传。
**仅监听 127.0.0.1:8765**，唯一调用方是 web 应用（Next.js），不直接暴露局域网。

## 快速开始

```bash
# 1. 初始化（核心 + STT + TTS）
../../scripts/engine-setup.sh

# 2. 启动
uv run uvicorn app.main:app --port 8765

# 3. 验证能力（如实报告各引擎可用性）
curl -s http://127.0.0.1:8765/system/capabilities
```

## 架构要点

- **任务 API**：长任务（STT/批量 TTS/翻译）经 `POST /jobs` 提交、`GET /jobs/{id}` 轮询；
  asyncio 单 worker 串行消费（GPU 显存纪律）。任务注册表在内存中，重启即清空——
  持久化与崩溃恢复由 web 端 jobs 表负责（回查本 API 后标记可重试）。
- **能力探测**：`GET /system/capabilities` 按实际导入情况报告引擎可用性，
  web 端据此渲染能力下拉（不可用引擎灰显，绝不谎报）。
- **配置**：运行时配置在 `~/.pinglc/config.json`（设备/热加载/默认模型）；
  用户意图（provider 档案）在 web 端 SQLite，两者职责分离。
- **分层安装**：核心层（fastapi/httpx）必装；stt/tts/align 为可选 extra，
  MFA 仅以 Docker 镜像方式存在（`mfa-docker/`，M1 里程碑提供 Dockerfile）。

## 目录

```
app/
├── main.py          # 入口：lifespan（目录初始化/worker 启停）+ 路由挂载
├── settings.py      # ~/.pinglc 布局与 config.json 读写
├── api/
│   ├── system.py    # /health /system/capabilities /system/config
│   └── jobs.py      # /jobs 通用任务 API
└── jobs/
    └── runner.py    # 任务运行器（队列 + 单 worker + 取消）
```

M1 起：`engines/`（stt_whisper / tts_edge / tts_kokoro / translate_local / align_mfa）、
`providers/openai_compat.py`（云端透传）、`media/`（ffmpeg / yt-dlp）将陆续接入。
