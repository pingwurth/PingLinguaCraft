# PingLinguaCraft 开发约定（AGENTS.md）

> 面向 AI agent 的开发约定，内容与 CLAUDE.md 保持同步；修改任一份约定时，两处同步更新。

## 项目

PingLinguaCraft：媒体驱动的英文精听学习工具。导入音视频自动生成字幕（本地 faster-whisper）、导入文本生成音频（Edge-TTS/kokoro），逐句精读/听写/跟读/测验/闯关，AI 侍读相伴。**单用户自托管**，数据全在本机 `~/.pinglc/`，手机以 PWA 访问。路线图 M0–M5 见 README.md，当前处于 M0（脚手架）阶段。

## 编码规范

- 每个代码文件开头必需中文注释说明文件作用，每个函数必需有完整的中文doc，每个html元素必需中文注释
- 代码更新后要检查对应注释是否需要调整，按需调整即可

## 常用命令（仓库根）

```bash
pnpm install                            # Node ≥22 / pnpm 10
pnpm dev                                # 启动 web 开发服务 http://localhost:3000
pnpm -r typecheck && pnpm -r test && pnpm -r lint   # 三件套门禁（提交前必过）
pnpm db:generate && pnpm db:migrate     # schema 变更后（迁移目标 ~/.pinglc/pinglc.db）
./scripts/engine-setup.sh               # 初始化 AI 引擎（uv 依赖 + 可选 stt/tts/align 分层安装）
./scripts/start.sh                      # 一键后台启动 web(3000) + AI 引擎(8765)，日志在 ~/.pinglc/run/
./scripts/stop.sh                       # 停止上述服务（status 子命令查看运行状态）
./scripts/dev-https.sh                  # 局域网 HTTPS（手机联调/PWA/录音必需，mkcert）
```

测试目前集中在 `packages/core`（vitest）与 `services/ai-engine`（pytest，dev 依赖组）：

```bash
pnpm --filter @pinglc/core test                                # core 全部
pnpm --filter @pinglc/core exec vitest run tests/nlp.test.ts   # 单文件
pnpm --filter @pinglc/core exec vitest run -t "关键词"          # 按测试名匹配
uv run --directory services/ai-engine pytest                   # 引擎测试
```

## 架构

pnpm monorepo，四个工作区：

| 位置 | 内容 | 技术栈 |
|---|---|---|
| `apps/web` | Web 应用（UI + 全部业务 API + SQLite） | Next.js 15 / React 19 / Tailwind v4 / Drizzle / better-sqlite3 |
| `packages/core` | 双端共享纯逻辑（字幕解析/分词/分句/SRS/类型） | 纯 TS，**零运行时依赖（强制）**，以 TS 源码经 transpilePackages 消费 |
| `services/ai-engine` | 本地 AI 引擎 | FastAPI（uv 管理，Python **3.12 锁定**——whisperx 兼容性），仅监听 127.0.0.1:8765 |
| `apps/mobile` | Expo 应用（M5 已建骨架：设置屏→藏经阁→集→基础播放页；复用 @pinglc/core，Metro 配置支持 pnpm workspace） | expo-audio 音频 + 局域网 API |

关键架构约定（违反会破坏整体设计）：

- **Web 为编排者，engine 为无状态执行器**：DB 写入只发生在 web；engine 只做计算并回传结果。web 是 engine 的唯一调用方。
- **一切用户数据在 `~/.pinglc/`**：pinglc.db / media/ / models/ / caches/ / config.json；所有表预留 `user_id`（默认 1），便于未来迁移多用户。
- **长任务管线**：web 侧 `jobs` 表持久化任务并轮询 engine 的 `/jobs` API；引擎重启后由 web 回查并标记可重试。engine 的 JobRunner 按任务名注册 handler（M0 仅 echo，M1 起接 stt/tts_batch/translate 等真实任务）。
- **AI 能力路由**：六能力（stt/tts/align/translate/llm/speech_eval）× {local 引擎 | cloud 档案}；speech_eval（口语评测，跟读评分）仅云端（腾讯云 SOE，WS 录音文件模式），未配置时自动降级本地 STT 近似评分。`provider_profiles` 表支持同能力多档案切换。API Key 仅服务端读取，接口永不回传。
- **媒体流**：`/api/media/[materialId]` 必须保持 HTTP Range/206 语义（视频拖动依赖）；此类验证一律走 `next start`，不信 dev 代理。
- **播放器时钟**：rAF 读 currentTime（不用 timeupdate）；循环回跳在 rAF tick 内完成。
- **@pinglc/core 纪律**：不引 react/node 专属依赖，Expo 也要能直接消费。
- **设计系统**：token 在 `apps/web/src/app/globals.css`（纸墨风：#FBF9F5 底 / #B91C1C 朱砂 / #3F6212 竹青 / #1E2022 浓墨 / 1px #E3DDD2 细线 / 4px 圆角 / 无投影）；语义色一律用 token（如 `bg-primary`），不写裸色值。

### 数据层（apps/web）

- better-sqlite3 + Drizzle（WAL 模式 + busy_timeout），连接单例 `getDb()`（`apps/web/src/lib/db/index.ts`）；schema 与迁移都在 `src/lib/db/`，应用启动时自动应用未执行迁移。**已应用的迁移文件永不改动**（drizzle 按内容哈希识别，改动等于重跑 → DROP 重建丢数据）；迁移内事务中 `PRAGMA foreign_keys` 是 no-op，需要临时关外键时用 `PRAGMA defer_foreign_keys=ON`。
- 核心数据链路：collections → materials → cues。cues 是播放页一切功能的核心（双语文本、词级时间戳 wordsJson、STT 置信度、笔记）。
- 其余表承载学习资产（words/srs/favorites/learningProgress）与任务/配置（jobs/provider_profiles/settings/aiArtifacts 等），字段含义见 schema.ts 内中文注释。

### 引擎（services/ai-engine）

- 依赖分层：核心（fastapi/uvicorn/httpx/orjson）必装；stt（faster-whisper+CUDA）/ tts（edge-tts+kokoro）/ align（whisperx）为可选 extras。注意 `uv sync` 默认精确同步——多层安装须在**同一条**命令里声明全部 `--extra`；MFA 走 Docker 不入依赖。

## 提交纪律

- 里程碑粒度提交，信息中文，说明「做了什么 + 为什么」
- 提交前必须通过三件套门禁（typecheck / test / lint）
- pre-commit 钩子（`.githooks/`）自动执行门禁：首次克隆后运行 `git config core.hooksPath .githooks` 启用；紧急绕过用 `git commit --no-verify`
- AI 语义审查（alibaba/open-code-review）：`scripts/ai-review.sh` 审简洁性/架构/复用/维护/可读性 + 项目规范；规则在 `.opencodereview/rule.json`；critical/high 阻断，`SKIP_AI=1` 跳过此层；报告归档 `~/.pinglc/reviews/`

## 参考文档

- 需求全文：`docs/inspiration.md`；UI 设计稿：`docs/ui/`
- 完整技术计划：`~/.claude/plans/adaptive-swimming-raccoon.md`
- `CLAUDE.md`：面向 Claude Code 的相同开发约定；修改约定时两处保持同步
