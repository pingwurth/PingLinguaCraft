# PingLinguaCraft

> 书山万仞吾独取，不向旁人问径蹊

媒体驱动的英文精听学习工具：导入音视频自动生成字幕（本地 faster-whisper）、
导入文本自动生成音频（Edge-TTS / kokoro）、逐句精读 / 听写 / 跟读 / 测验 / 闯关，
AI 侍读全程相伴。单用户自托管，数据全在本机 `~/.pinglc/`，手机以 PWA 访问。

## 快速开始

```bash
# 1. 安装依赖（Node ≥22 / pnpm）
pnpm install

# 2. 初始化数据库（首次）
pnpm --filter @pinglc/web db:migrate

# 3. 启动 Web
pnpm dev                          # 开发：http://localhost:3000

# 4. （推荐）初始化并启动本地 AI 引擎
./scripts/engine-setup.sh
uv run --directory services/ai-engine uvicorn app.main:app --port 8765

# 5. 手机局域网访问（HTTPS，PWA/录音必需）
./scripts/dev-https.sh
```

## 仓库结构

| 目录 | 说明 |
|---|---|
| `apps/web` | Next.js 15 应用（UI + API + SQLite/Drizzle） |
| `packages/core` | 双端共享纯逻辑（字幕解析/分词/分句/SRS） |
| `services/ai-engine` | 本地 AI 引擎（FastAPI：STT/TTS/对齐/翻译/LLM） |
| `docs/` | 需求（inspiration.md）与设计稿（ui/ + 设计系统 DESIGN.md） |
| `scripts/` | 引擎初始化 / 局域网 HTTPS / 备份 |

## 开发约定

见 [AGENTS.md](./AGENTS.md)。门禁：`pnpm -r typecheck && pnpm -r test && pnpm -r lint`。

## 路线图

- **M0 脚手架 + 设计系统**（当前）：monorepo / 设计 token / 双壳 / DB schema / Range 流式 / 引擎骨架
- **M1 MVP 核心闭环**：三种导入 → STT → 分句 → 翻译 → 播放页（当前句 + 双语精读）→ 生词/收藏/笔记
- **M2 练习模式**：听写 / 跟读 / 测验
- **M3 AI 侍读 + 闯关**：悬浮球助手、六模式闯关、AI 关卡页
- **M4 SRS + 词汇深度**：FSRS 复习、词源拓扑、深学卡
- **M5 打磨 + Expo**：移动原生应用（复用 core）
