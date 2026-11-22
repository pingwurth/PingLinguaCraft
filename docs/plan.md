# PingLinguaCraft 实施计划与进度

> 进度快照：2026-11-16。逐条对照 `docs/inspiration.md` 的 19 条需求核实代码实现（非仅凭里程碑标记）。
> 软件名 PingLinguaCraft · slogan「书山万仞吾独取，不向旁人问径蹊」。

## 一、总体进度

**19/19 条需求已全部落地**（M0–M5 里程碑交付），当前处于 M5 收尾打磨阶段：工作区有一批已暂存未提交的加固变更（见第五节），TODO 仅剩 iOS 证书信任一件。自增功能「语流页」（跨材料连续研习流）已于 2026-11-16 交付。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架 + 设计系统（纸墨风 token） | ✅ |
| M1 | MVP 核心闭环：三种导入 → STT → 分句 → 翻译 → 播放页 → 生词/收藏/笔记 | ✅ |
| M2 | 练习模式：听写（双模式）/ 跟读录音 / LLM 测验 + 错题本 | ✅ |
| M3 | AI 侍读 + 闯关：悬浮球流式对话、划词提问、六玩法闯关、AI 关卡页（沙箱） | ✅ |
| M4 | SRS + 词汇深度：FSRS-6 多题型复习、词源拓扑、仿写构架 | ✅ |
| M5 | 打磨 + Expo：serwist PWA 离线壳、Expo 应用骨架、腾讯云 SOE 口语评测（降级本地近似） | ✅（收尾中） |

## 二、需求实现对照表（19 条全核实）

| # | 需求 | 状态 | 实现位置 |
|---|---|---|---|
| 1 | 音视频导入自动生成字幕 | ✅ | 导入向导「本地文件」`/api/import/upload` → jobs 排队 stt（本地 faster-whisper）；附带字幕文件可免 STT |
| 2 | 文本导入自动生成音频 | ✅ | 导入向导「文本」`/api/import/text` → core 分句 → TTS（edge-tts/kokoro）；另有「链接」路径（yt-dlp，顺带抓官方英文字幕）`/api/import/link` |
| 3 | 导入后跳转播放页 | ✅ | 导入完成进入 `material/[id]`；字幕未就绪时显示任务进度面板（jobs 轮询，终态自动刷新，可离开页面任务继续） |
| 4 | 播放页深度适配移动设备 | ✅ | 移动单列 + sticky 播放器/标签条 + safe-area/dvh；桌面 md+ 播放器与内容左右分栏 |
| 5 | 句数/词数统计（去重） | ✅ | `materials.sentenceCount / uniqueWordCount` 落库，播放页标题栏展示 |
| 6 | 控制条 hover 显示/1s 渐隐、移动点按 | ✅ | `features/player/Player.tsx`：桌面 mouseEnter 显示、mouseLeave 1s 后渐隐；移动点按切换、播放中 3s 自动隐藏 |
| 7 | 五标签页 | ✅ | `app/material/[id]/page.tsx`：当前句 / 双语精读 / 听写 / 跟读 / 测验 |
| 8 | 当前句标签页全部功能 | ✅ | `CurrentSentenceTab.tsx`：一键复制原文/译文；点词暂停 + 英音朗读 + 加生词入口；Markdown 笔记（编辑+预览）；句子 AI 解析并收藏（`/api/cues/[id]/analyze`）；关卡生成（`/api/cues/[id]/level` → iframe 沙箱加载 `/artifacts/[id]`，严格 CSP + 目录收窄防穿越） |
| 9 | 双语精读全部功能 | ✅ | `BilingualTab.tsx`：字幕跟随播放滚动（激活句居中+朱砂左边线）；单句重译中英互译（`/api/cues/[id]/retranslate`）；字幕导入/导出（`/api/materials/[id]/subtitles`）；整集重译/重 STT（`retranslate`/`restt`）；单条纠错（编辑原文/译文/时间 ±100ms 步进/单句重 STT/插入/删除，`/api/cues/[id]`） |
| 10 | 听写双模式 | ✅ | `DictationTab.tsx`：选词拼句（种子洗牌可复现 + 邻句干扰词，即时校验）/ 完整句子听写（core.diffSentence 词级判分，typo 宽容）；句间导航 |
| 11 | 跟读：听原文/录音/播录音 | ✅ | `ShadowingTab.tsx`：单句播放到句尾自停；MediaRecorder 录音（安全上下文/权限错误就地提示）；即时回放 + 历史录音列表（可播/删，recordings 表） |
| 12 | 测验：选择/填空/问答 | ✅ | `QuizTab.tsx` + `/api/materials/[id]/quiz*`：LLM 生成（轮询进度）→ 逐题作答 → 服务端判分 → 问答两段式自评（对照参考答案「掌握/未掌握」）→ 成绩解析 + 错题回顾（quizAttempts 表） |
| 13 | 句子收藏分类 | ✅ | `favorites` 页 + `favorite-categories`：自定义分类、重新生成 AI 解析、笔记查看（MarkdownView 渲染） |
| 14 | 生词本 | ✅ | `words` 页：多个生词本（word-books）；点词/划词添加；单词 Markdown 笔记（编辑+预览）；AI 自动生成笔记（`/api/words/[id]/ai-note`）；M4 增词源拓扑与仿写构架（`/api/words/[id]/deep`） |
| 15 | AI 侍读悬浮球 + 抽屉 | ✅ | `Assistant.tsx`：所有页面右下角悬浮球（避开底部导航安全区），抽屉打开时隐藏；移动端底部抽屉 90dvh，桌面右侧抽屉 1/6 视口起可拖拽调整（持久化）；SSE 流式对话（aiThreads/aiMessages）；`SelectionAsk.tsx` 监听 selectionchange 划词带引用提问 |
| 16 | 播放器控制全集 | ✅ | `Player.tsx` + `store.ts` + `useMediaClock.ts`：单句循环、A-B 片段循环（进度条高亮）、整集循环、倍速、音量、双语切换（HTML 字幕层，非 `<track>`）、±5s/上下句、缓冲区显示；rAF 时钟，循环回跳在 tick 内完成 |
| 17 | 闯关模式六玩法 | ✅ | `material/[id]/challenge` + `features/challenge/*`：九宫格选词拼句（GridMode）/ 单句听写（DictationMode）/ 跟读评分 + 影子跟读（ShadowMode，云端 SOE 词级+音素级，未配置降级本地 STT 近似）/ 全文背诵（ReciteMode，≥80 过关、重试得分递减）/ 情景实战（ScenarioMode，AI 逐句点评）；听过一遍（progress.listenedThrough）解锁；challengeRecords 记录成绩 |
| 18 | 生词复习多题型 | ✅ | `review` 页 + `/api/review/queue|answer`：FSRS-6 调度（与 ts-fsrs 对齐）；题型按词自适应——cloze 原句挖空 / listen 听音选词 / meaning 释义选词；答后四档评分（again/hard/good/easy）；srsCards + srsReviewLogs |
| 19 | 首页材料集汇聚 | ✅ | 首页「藏经阁」：统计条（卷数/总时长/句段数）+ 材料集网格 + 新建 + 导入入口；`collection/[id]` 材料列表支持分页查询、处理中材料内联进度 |

## 三、基础设施与跨端状态

| 领域 | 状态 | 说明 |
|---|---|---|
| 数据层 | ✅ | better-sqlite3 + Drizzle（WAL），17 张表（collections/materials/cues/words/srs/favorites/jobs/providers/recordings/ai*/quiz/challenge 等），全表预留 `user_id`；数据全在 `~/.pinglc/` |
| AI 引擎 | ✅ | FastAPI（127.0.0.1:8765），JobRunner 按任务名注册 handler；stt/tts/align 分层可选安装；六能力路由本地↔云端，API Key 仅服务端 |
| 长任务管线 | ✅ | web 侧 jobs 表持久化 + 轮询；引擎重启后 web 回查标记可重试 |
| 媒体流 | ✅ | `/api/media/[materialId]` HTTP Range/206（视频拖动）；Range 解析已抽入 `packages/core/src/media/range.ts`（RFC 9110 表驱动测试） |
| PWA | ✅ | serwist SW + 离线壳页（`/offline`，独立缓存策略规避 revision 锁死问题）+ SwRegister |
| Expo 移动端 | 🟡 骨架 | `apps/mobile`：三屏（设置→藏经阁→基础播放页，expo-audio，复用 @pinglc/core，零导航库依赖）；web 端 19 条功能未同步，属后续增量 |
| 测试门禁 | ✅ | 三件套（typecheck/test/lint）pre-commit 强制；packages/core vitest（字幕解析/分词/分句/SRS/Range 等）；引擎 pytest；AI 语义审查（critical/high 阻断） |
| 运维脚本 | ✅ | engine-setup / start / stop / dev-https（mkcert 局域网 HTTPS）/ backup，日志在 `~/.pinglc/run/` |

## 四、进行中 / 待收尾

1. **已暂存未提交变更（~723 行，当前 HEAD `1f7501d`）**——数据库与媒体基建加固一批：
   - DB 迁移从 `getDb()` 懒触发改为**应用启动时一次性执行 + 迁移前自动快照**（`lib/db/migrate.ts`、`paths.ts` 拆分、`instrumentation.ts`）
   - HTTP Range 解析抽入 `packages/core`（`media/range.ts` + RFC 9110 边界表驱动测试），媒体路由复用
   - 脚本加固（backup / dev-https / https-proxy / lib）与 pre-commit、AI 审查规则更新
   - **下一步**：过三件套门禁后按主题提交
2. **手机证书信任**：安卓已安装并验证通过（2026-11-16，步骤沉淀在 `docs/mkcert-android.md`）；iOS 仍待做（如需 iPhone 联调）
3. **Expo 应用**：仅骨架（音频播放 + 双语跟随），练习/闯关/复习/侍读均未同步

### 已交付的自增功能

- **语流页（`/stream`，2026-11-16）**：全部就绪材料的连续研习流——队列按「最近研习优先」排列（chips 快速换材）、自动连播、字幕瀑布跟随（激活句居中、点句跳播、已过句淡出）、精简控制（上下句/倍速/进度条）；位图进度上报与精读页共用（`useProgressReporter`，语流听过同样计入闯关解锁）。API：`GET /api/stream/queue`。

## 五、下一步实施计划（建议优先级）

| 优先级 | 事项 | 说明 |
|---|---|---|
| P0 | 提交基建加固变更 | 三件套门禁 + AI 审查通过后提交暂存区内容 |
| P0 | 手机真机 PWA 联调验收 | 安卓证书已就绪（2026-11-16）→ 真机过一遍导入/播放/录音/跟读链路，重点验证需求 4 移动适配与需求 6 控制条交互 |
| P1 | 备份/恢复演练 | backup.sh 已加固，做一次真实恢复演练（`~/.pinglc` 是唯一数据源，值得验证闭环） |
| P1 | Expo 功能补齐评估 | 按使用频率排序增量同步（候选：听写/跟读 → 复习 → 侍读），或先确认 PWA 已满足手机场景则降低优先级 |
| P2 | 多用户 | 表已预留 `user_id`，当前单用户自托管定位下不急 |

---

*本文档随进度更新；需求全文见 `docs/inspiration.md`，UI 设计稿见 `docs/ui/`，完整技术计划见 `~/.claude/plans/adaptive-swimming-raccoon.md`。*
