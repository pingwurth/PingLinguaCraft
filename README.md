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

## 新机器部署（从零到可跑）

前置：`git`、Node ≥22 + pnpm 10、`uv`、`ffmpeg`；`docker` 仅 MFA 对齐镜像需要；
NVIDIA 驱动可选（无 GPU 引擎自动落 CPU）；Python 3.12 无需预装（uv 自动管理）。

```bash
# 1. 克隆并启用门禁钩子（pre-commit 三件套）
git clone git@github.com:pingwurth/PingLinguaCraft.git && cd PingLinguaCraft
git config core.hooksPath .githooks

# 2. 引擎全量初始化：uv 按 lock 精确同步 stt/tts/align 全部 extras + 构建 MFA Docker 镜像
./scripts/engine-setup.sh --all

# 3. Web 依赖与数据库（迁移文件随仓库分发，直接应用即可）
pnpm install
pnpm db:migrate

# 4. 一键后台启动 web(3000) + 引擎(8765)，日志在 ~/.pinglc/run/
./scripts/start.sh

# 5. 验证：能力探测应如实报告 stt / tts / whisperx / mfa 各引擎可用性
curl -s http://127.0.0.1:8765/system/capabilities
```

可复现性：引擎依赖由 `services/ai-engine/uv.lock` 精确锁定（whisperx / torch 版本
与开发机一致）；MFA 镜像由 `services/ai-engine/mfa-docker/Dockerfile` 锁版本构建
（MFA 3.4.3 + 英语声学模型烘焙进镜像层，运行期离线）。首次部署耗时主要在下载
（torch ~2.5GB、MFA conda 解算与模型），重复构建有 uv / Docker 层缓存提速。

国内网络注意：MFA 模型托管在 GitHub Releases，直连会 SSL 中断——
`engine-setup.sh` 在宿主侧预下载模型（curl 自动走系统代理 `https_proxy`，
支持断点续传、在位跳过），构建期 COPY 进镜像，容器内不联网。

分层裁剪：只装基线（STT+TTS，不含对齐）用无参 `./scripts/engine-setup.sh`；仅核心
API 层用 `--core`。缺哪层，`/system/capabilities` 就如实报告哪层不可用，UI 优雅降级。

## 仓库结构

| 目录 | 说明 |
|---|---|
| `apps/web` | Next.js 15 应用（UI + API + SQLite/Drizzle + serwist PWA） |
| `apps/mobile` | Expo 应用骨架（expo-audio 播放，复用 core，连局域网） |
| `packages/core` | 双端共享纯逻辑（字幕解析/分词/分句/SRS） |
| `services/ai-engine` | 本地 AI 引擎（FastAPI：STT/TTS/对齐/翻译/LLM） |
| `docs/` | 需求（inspiration.md）与设计稿（ui/ + 设计系统 DESIGN.md） |
| `scripts/` | 引擎初始化 / 局域网 HTTPS / 备份 |

## 开发约定

见 [AGENTS.md](./AGENTS.md)。门禁：`pnpm -r typecheck && pnpm -r test && pnpm -r lint`。

## 路线图

- **M0 脚手架 + 设计系统** ✅
- **M1 MVP 核心闭环** ✅ 三种导入 → STT → 分句 → 翻译 → 播放页（当前句 + 双语精读）→ 生词/收藏/笔记
- **M2 练习模式** ✅ 听写（双模式）/ 跟读录音 / LLM 测验 + 错题本
- **M3 AI 侍读 + 闯关** ✅ 悬浮球流式对话、划词提问、六玩法闯关、AI 关卡页（沙箱）
- **M4 SRS + 词汇深度** ✅ FSRS-6（与 ts-fsrs 对齐）多题型复习、词源拓扑、仿写构架
- **M5 打磨 + Expo** ✅ serwist PWA 离线壳 + Expo 应用骨架（设置→藏经阁→基础播放页，复用 core）；跟读口语评测接腾讯云 SOE（词级+音素级，未配置自动降级本地近似评分）

19 条需求全部落地。
