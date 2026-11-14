- [ ] 手机真机信任 mkcert 证书（./scripts/dev-https.sh 首次运行后，把 mkcert -CAROOT 下的 rootCA.pem 传到手机安装；iOS 还需在证书信任设置里开启完全信任）

## AI 审查遗留（2026-11-15 三轮审查清零阻断后的待办，报告在 ~/.pinglc/reviews/）

### 值得排期（设计改进）

- [ ] `scripts/ai-review.sh` 增加 `--staged` 模式，pre-commit 只审暂存快照（现在审整个工作区：未暂存的 WIP 也会阻断本次提交、内容与提交内容不一致；ocr workspace 模式无此能力，需用 git diff --cached 或临时 stash 构造 staged-only diff）
- [ ] `parseRange` 从 media 路由抽到 @pinglc/core 并补表驱动 vitest 测试（RFC 9110 状态机：多区间/后缀溢出/倒置/大小写等边界极易回归，apps/web 目前无测试基建）
- [ ] DB 迁移改到 Next `instrumentation.ts` 启动时一次性执行 + 迁移前自动快照库文件（现在 getDb() 懒触发：迁移失败后每请求重开连接重跑迁移抖动；DDL 前无回退点，~/.pinglc 是唯一数据源）
- [ ] `scripts/https-proxy.mjs` 流健壮性三连：res 补 error 监听（EPIPE 会带崩整个代理）、背压期禁用空闲超时（手机 TCP 窗收拢时 30s 定时器误杀健康媒体流）、server.close 有界退出（媒体流播放中 Ctrl+C 永不退出，trap 不触发留 next start 孤儿占 3000）

### 快速可做（下轮顺手）

- [ ] media 路由：后缀区间与 MAX_CHUNK 出口钳制的相互作用（bytes=-20MB 的尾部会被截掉 11MB——探测 MP4 moov 的场景受影响；解析阶段就按文件尾锚定限窗）
- [ ] `.githooks/pre-commit`：`.sql` / `services/ai-engine/pyproject.toml` / `uv.lock` 纳入门禁触发（这类提交现在跳过全部五道门禁）；`uv run` 加 `--locked`（lock 过期直接失败而非静默改写）；加 `git diff --cached --check` 拦冲突标记；shell 暂存文件过一道 `bash -n`
- [ ] `scripts/dev-https.sh`：cleanup trap 提前注册到 spawn 之前（spawn 失败/Ctrl+C 时 next start 成孤儿占 3000）
- [ ] `scripts/backup.sh`：sqlite3 CLI 分支的 .backup 路径做单引号转义（DEST_DIR 含引号时 dot-command 语法错误）；考虑 GNU tar --transform 的可移植性说明
- [ ] `scripts/lib.sh` spawn_group：spawn 前先清掉残留 pid 文件（dev-https 被 SIGKILL 后留下的旧文件会让 3s 落盘检测假成功）
