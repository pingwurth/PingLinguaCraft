#!/usr/bin/env bash
# ai-review.sh —— AI 代码审查封装（基于 alibaba/open-code-review，命令 ocr）
#
# 作用：对代码变更做语义级 AI 审查——简洁性、架构设计、复用性、维护性、
#       可读性，以及项目自定义规范（.opencodereview/rule.json 按路径分层
#       定义了四工作区的纪律，AGENTS.md 作为审查背景喂入）。
#
# 拦截策略：severity 命中 BLOCK_SEVERITIES（默认 critical/high）→ 退出码 1
#           阻止提交；中低级别仅打印提醒。逃生口：SKIP_AI=1（留痕于
#           ~/.pinglc/reviews/skip.log，规则飞轮的回看触发点）或 git 层的
#           --no-verify（绕过整个 pre-commit 钩子，本脚本无从感知、不会留痕）。
#
# 自动归档：每次审查成功后，将完整 HTML 报告归档到 ~/.pinglc/reviews/
#           （命名：时间戳[-commit短哈希|-from分支].html），仅保留最近 ARCHIVE_KEEP 份；
#           归档失败不影响审查结论（非致命）。
#
# 降级原则：AI 层是「增强」而非「硬依赖」——ocr 未安装、provider 未配置、
#           网络/模型故障、超时、结果解析失败，一律黄字提示后放行（退出码 0），
#           绝不因基础设施问题卡死提交流程；只有「确认的阻断级发现」才挡提交。
#
# 用法：
#   ./scripts/ai-review.sh                   # 审查工作区全部变更（staged+unstaged+untracked）
#   ./scripts/ai-review.sh --staged          # 只审查暂存区快照（pre-commit 场景：
#                                            #   未暂存的 WIP 不入审、审查内容与提交严格一致；
#                                            #   实现：HEAD 基线 + checkout-index 导出暂存内容
#                                            #   构造一次性快照仓库，ocr --repo 指向它）
#   ./scripts/ai-review.sh --commit abc123   # 审查某个 commit
#   ./scripts/ai-review.sh --from main [--to <ref>]
#                                            # 里程碑复审：整分支累计 diff（merge-base 模式）。
#                                            #   pre-commit/单 commit 只看得到单次增量，跨 commit
#                                            #   的涟漪（第 1 个 commit 改契约、第 8 个忘了跟）
#                                            #   只有这一层能覆盖；收尾时建议配 OCR_EFFORT=high
#   SKIP_AI=1 ./scripts/ai-review.sh         # 跳过
#
# 退出码（pre-commit 据此区分「代码有问题」与「工具出问题」）：
#   0 = 通过（含降级放行：ocr 缺失/超时/未配置 provider 等）
#   1 = 存在阻断级发现（critical/high）—— 应阻止提交
#   2 = 工具侧前提不满足（参数误用、仓库无 HEAD 基线等）—— 调用方应降级放行
#
# 环境变量（均可选）：
#   OCR_EFFORT=high         审查深度 low|medium|high（默认 medium）
#   OCR_TIMEOUT_MIN=20      任务预算分钟（默认 10；--from 模式未显式指定时自动放宽到 20，
#                           防整分支 diff 在预算内跑不完 → 降级放行形同虚设）
#   OCR_BACKGROUND="..."    本次变更意图（一句话需求）。ocr 的 --background-file 优先于
#                           --background，故设此变量时与 AGENTS.md 合成「意图在前 + 项目
#                           约定在后」的临时背景一次喂入——大变更给一句，agent 知道在加
#                           功能就不会把临时简化当缺陷，误报更少
#   OCR_ARCHIVE_DIR / OCR_ARCHIVE_KEEP    归档目录 / 保留份数
#
# 前置（一次性）：
#   npm install -g @alibaba-group/open-code-review   # 安装 ocr（本机已装）
#   ocr config provider && ocr config model          # 交互配置云端 provider（key 存本机，不入仓库）
#   依赖 python3（结果解析/归档）；timeout 为 GNU 专属，macOS 需 brew coreutils（gtimeout），缺失时自动降级为不设墙钟
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---- 可配置项 ----
BLOCK_SEVERITIES="critical high"   # 命中即阻断的严重级别（ocr 枚举：critical/high/medium/low）
EFFORT="${OCR_EFFORT:-medium}"     # 审查深度：low | medium | high（可用环境变量覆盖）
TIMEOUT_MIN="${OCR_TIMEOUT_MIN:-10}"  # ocr 并发任务预算（分钟，可用 OCR_TIMEOUT_MIN 覆盖）
# WALL_CLOCK 延后到参数解析之后再算：--from 里程碑模式会按模式放宽 TIMEOUT_MIN（见参数解析处）
ARCHIVE_DIR="${OCR_ARCHIVE_DIR:-$HOME/.pinglc/reviews}"  # HTML 报告归档目录（遵循「一切用户数据在 ~/.pinglc/」约定）
ARCHIVE_KEEP="${OCR_ARCHIVE_KEEP:-50}"  # 归档保留份数，超出删最旧

# ---- 状态输出 ----
info() { printf '\033[1;34m[AI审]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[AI审]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[AI审]\033[0m %s\n' "$*" >&2; }

# ---- 逃生口 ----
if [[ "${SKIP_AI:-0}" == "1" || "${SKIP_GATES:-0}" == "1" ]]; then
  warn "SKIP_AI/SKIP_GATES=1，跳过 AI 代码审查"
  # 规则飞轮触发点：强过不留痕则事后无从回看——追加一行到归档目录旁的 skip.log，
  # 里程碑收尾翻此文件与归档报告，评估是否有该沉淀进 rule.json 的教训（见 CLAUDE.md 规则飞轮）；
  # 与 HTML 归档同纪律做长度封顶（仅留最近 200 条），避免常年积累把回看文件养成垃圾山
  if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
    printf '%s HEAD=%s 跳过 AI 审查（若为强过阻断级发现，事后回看并评估沉淀规则）\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" "$(git rev-parse --short HEAD 2>/dev/null || echo '?')" \
      >>"$ARCHIVE_DIR/skip.log" 2>/dev/null || true
    tail -n 200 "$ARCHIVE_DIR/skip.log" >"$ARCHIVE_DIR/skip.log.tmp" 2>/dev/null \
      && mv -f "$ARCHIVE_DIR/skip.log.tmp" "$ARCHIVE_DIR/skip.log" || rm -f "$ARCHIVE_DIR/skip.log.tmp"
  fi
  exit 0
fi

# 参数校验放在逃生口之后（此前在前：环境里残留非法 OCR_TIMEOUT_MIN 时，SKIP_AI=1
# 也会 exit 2 而不是跳过，违背逃生口语义）：非正整数会让后续算术展开
# $((TIMEOUT_MIN * 60 + 120)) 直接报错，在 set -e 下整个审查（进而整个提交）
# 被莫名中止；这是工具侧配置错误，退出码用 2（调用方降级放行而非误报阻断级发现）
if [[ ! "$TIMEOUT_MIN" =~ ^[1-9][0-9]*$ ]]; then
  fail "OCR_TIMEOUT_MIN 须为正整数分钟数（当前值：$TIMEOUT_MIN）"
  exit 2
fi

# ---- 依赖检查：无 ocr 则降级放行 ----
if ! command -v ocr >/dev/null 2>&1; then
  warn "未安装 ocr（@alibaba-group/open-code-review），跳过 AI 审查"
  warn "安装：npm install -g @alibaba-group/open-code-review && ocr config provider"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  warn "未安装 python3（结果解析/归档依赖），跳过 AI 审查"
  exit 0
fi

# ---- 临时文件：ocr 的 JSON 输出 + 渲染结果（模板不带后缀——BSD mktemp 要求 X 结尾）----
# 先于参数解析注册清理：--staged 的快照仓库目录、合成的背景文件创建后任何一步退出都不留 /tmp 残骸。
# mktemp 失败（/tmp 满等）显式走 exit 2：裸 set -e 中止的退出码是 1，会被 pre-commit
# 误报成「存在阻断级发现」卡死提交，违背「AI 层故障绝不卡死提交」约定
json_file="$(mktemp /tmp/pinglc-ai-review.XXXXXX)" || { fail "临时文件创建失败（/tmp 可写？）"; exit 2; }
render_file="$(mktemp /tmp/pinglc-ai-render.XXXXXX)" || { fail "临时文件创建失败（/tmp 可写？）"; exit 2; }
snap_dir=""      # --staged 模式的临时快照仓库目录（构造后由 EXIT trap 一并清理）
bg_file=""       # OCR_BACKGROUND 注入时合成的临时背景文件（同上）
trap 'rm -f "$json_file" "$render_file" ${bg_file:+"$bg_file"}; if [[ -n "${snap_dir:-}" ]]; then rm -rf "$snap_dir"; fi' EXIT

# ---- 构造「暂存区快照」一次性 git 仓库（--staged 模式）----
# 为什么需要：ocr 的 workspace 模式只能审「staged+unstaged+untracked」整个工作区，
# 提交场景下未暂存的 WIP 也会入审——内容与本次提交不一致，WIP 问题会误阻断提交。
# 做法：HEAD 树展开为一次性仓库并提交为基线；再用 checkout-index 把暂存内容覆盖
# 上去、删掉暂存删除的文件，全部 add 进 index——该仓库相对基线的「workspace 变更」
# 恰为「暂存区 vs HEAD」，ocr 审它即审本次将提交的内容。全程只读用户仓库。
# 每步显式 || return 1：本函数在 if 条件上下文中被调用，函数体内 errexit 被抑制，
# 中途失败若不显式传播会继续执行后续步骤、以最后一步的成功掩盖半成品快照。
# add 用 -f：快照仓库继承了 HEAD 的 .gitignore，被 git add -f 强加进暂存的文件
# 若被忽略规则跳过，快照 diff 会丢失这部分内容、背离「审查内容与提交严格一致」。
build_staged_snapshot() { # $1=快照目录
  local snap="$1"
  # 钩子环境会导出 GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE（git commit -a、
  # worktree 调用时），它们优先级高于 -C——不剥离的话快照仓库操作会落回用户
  # 仓库、污染正在进行的提交所用的临时 index。仅快照仓库侧的调用走该包装；
  # 下方对用户仓库的调用（archive / checkout-index / diff）必须保留原环境
  local -a snap_git=(env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_PREFIX git)
  # 1) HEAD 树展开为基线（内容取自 git 对象库，不经 shell 展开，路径安全）
  git archive HEAD | tar -x -C "$snap" || return 1
  # 2) 快照目录成为一次性仓库，基线先行提交（跳过钩子/签名，匿名作者）
  "${snap_git[@]}" -C "$snap" init -q -b main || return 1
  "${snap_git[@]}" -C "$snap" add -A -f || return 1
  "${snap_git[@]}" -C "$snap" -c user.name=ai-review -c user.email=ai-review@localhost \
    commit -q --no-gpg-sign --no-verify -m "baseline(HEAD)" || return 1
  # 3) 暂存内容覆盖快照（checkout-index 导出 index 内容，即暂存版本；-f 覆盖基线文件）
  git checkout-index --prefix="$snap/" -a -f || return 1
  # 4) 暂存为「删除」的文件从快照移除（--no-renames 让重命名表现为 D+A，旧路径得以清理）
  git diff --cached --name-only --diff-filter=D --no-renames -z |
    while IFS= read -r -d '' f; do rm -f -- "$snap/$f"; done || return 1
  # 5) 暂存内容全部入 index：该仓库 workspace 变更 == 暂存区 vs HEAD
  "${snap_git[@]}" -C "$snap" add -A -f || return 1
}

# ---- 参数 → ocr review 目标（默认 workspace 模式：staged+unstaged+untracked）----
# 三种定向模式互斥：--commit 审单个提交 / --staged 审暂存快照 / --from [--to] 审整分支
usage() { echo "用法: $0 [--staged | --commit <hash> | --from <ref> [--to <ref>]]" >&2; }
# 定向模式互斥预检：--staged 分支会在解析中途执行并可能提前退出，必须先保证参数组合合法
mode_cnt=0
for a in "$@"; do
  case "$a" in --staged|--commit|--from) mode_cnt=$((mode_cnt + 1)) ;; esac
done
if (( mode_cnt > 1 )); then
  echo "--staged/--commit/--from 互斥，只能选一个" >&2
  usage
  exit 2
fi
target=()         # 追加到 ocr review 的目标参数（--commit / --repo / --from / --to）
archive_tag=""    # 归档文件名后缀（--commit / --from 模式）
scope_desc="工作区变更（staged+unstaged+untracked）"  # 启动日志里的审查范围描述
from_ref=""       # --from 的源 ref（--to 展示用）
to_ref=""         # --to 的目标 ref（重复出现即参数误用）
mode=workspace
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      [[ "$mode" == "workspace" && -n "${2:-}" ]] || { usage; exit 2; }
      target+=(--commit "$2")
      archive_tag="-commit-${2:0:7}"
      scope_desc="commit ${2:0:7}"
      mode=commit
      shift 2
      ;;
    --from)
      [[ "$mode" == "workspace" && -n "${2:-}" ]] || { usage; exit 2; }
      target+=(--from "$2")
      archive_tag="-from-${2//\//-}"   # ref 可能含 /（如 origin/main），归档文件名转义
      from_ref="$2"
      scope_desc="分支 diff（${2}..HEAD）"
      mode=from
      shift 2
      ;;
    --to)
      [[ "$mode" == "from" && -n "${2:-}" && -z "${to_ref:-}" ]] || { usage; exit 2; }
      to_ref="$2"
      target+=(--to "$2")
      # 目标 ref 也进归档名（ref 含 / 转义），多次 --to 在上方守卫拦截——
      # 重复 --to 会把参数错误留给 ocr，落入「执行失败/超时」降级放行，审查形同虚设
      archive_tag="${archive_tag}-to-${2//\//-}"
      scope_desc="分支 diff（${from_ref}..${2}）"
      shift 2
      ;;
    --staged)
      [[ "$mode" == "workspace" ]] || { usage; exit 2; }
      # --quiet：仅以退出码表达「暂存区有无差异」
      if git diff --cached --quiet; then
        warn "暂存区无变更，跳过 AI 审查"
        exit 0
      fi
      if ! git rev-parse --verify -q HEAD >/dev/null; then
        fail "仓库尚无任何提交，--staged 模式不可用（无 HEAD 基线）"
        exit 2
      fi
      # mktemp/构造失败（/tmp 满、git 过老不认 init -b 等）属工具侧故障，退出码 2：
      # pre-commit 据此降级放行。不降级为整工作区审查——那会让未暂存 WIP 的发现
      # 阻断一次与它无关的提交，恰是 --staged 要解决的问题换个形态复活
      snap_dir="$(mktemp -d /tmp/pinglc-ai-staged.XXXXXX)" || { fail "快照目录创建失败（/tmp 可写？）"; exit 2; }
      if ! build_staged_snapshot "$snap_dir"; then
        rm -rf "$snap_dir"; snap_dir=""
        fail "暂存快照构造失败（git ≥2.28？/tmp 可写？），本次降级放行"
        exit 2
      fi
      info "--staged 模式：已构造暂存快照仓库 $snap_dir（未暂存的 WIP 不入审）"
      target=(--repo "$snap_dir")
      scope_desc="暂存区快照（vs HEAD）"
      mode=staged
      shift 1
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

# 里程碑整分支 diff 远大于单提交/工作区：预算不放宽会「预算内跑不完 → 状态不 complete →
# 降级放行」，复审形同虚设；仅在用户未显式指定 OCR_TIMEOUT_MIN 时自动放宽
if [[ "$mode" == "from" && -z "${OCR_TIMEOUT_MIN:-}" ]]; then
  TIMEOUT_MIN=20
fi
# 整体墙钟上限（秒）：任务预算 + 2min 余量，保证 ocr 自身预算先到期并正常落盘结果，而非被外层截杀
WALL_CLOCK=$((TIMEOUT_MIN * 60 + 120))

# ---- 墙钟包装：timeout 是 GNU 专属，macOS 为 gtimeout（brew coreutils），都没有则不设限 ----
REVIEW_TO=()   # 审查命令的墙钟包装
EXPORT_TO=()   # 归档导出的短墙钟包装
if command -v timeout >/dev/null 2>&1; then
  REVIEW_TO=(timeout "$WALL_CLOCK")
  EXPORT_TO=(timeout 60)
elif command -v gtimeout >/dev/null 2>&1; then
  REVIEW_TO=(gtimeout "$WALL_CLOCK")
  EXPORT_TO=(gtimeout 60)
else
  warn "无 timeout/gtimeout，本次不设墙钟上限（信任 ocr 自身 --timeout 预算）"
fi

# ---- 审查背景：默认 AGENTS.md 全项目约定；设 OCR_BACKGROUND 时注入「本次变更意图」----
# ocr 中 --background-file 优先于 --background（同给则后者被忽略），故意图存在时合成
# 「意图在前 + AGENTS.md 在后」的临时文件一次喂入：变更意图精准引导 + 项目约定不丢
bg_args=()
if [[ -n "${OCR_BACKGROUND:-}" ]]; then
  bg_file="$(mktemp /tmp/pinglc-ai-bg.XXXXXX)" || { fail "临时背景文件创建失败（/tmp 可写？）"; exit 2; }
  {
    printf '## 本次变更意图\n\n%s\n' "$OCR_BACKGROUND"
    if [[ -f AGENTS.md ]]; then
      printf '\n---\n\n'
      cat AGENTS.md
    fi
  } >"$bg_file"
  bg_args=(--background-file "$bg_file")
  info "审查背景：变更意图已注入（与 AGENTS.md 合成）"
elif [[ -f AGENTS.md ]]; then
  bg_args=(--background-file AGENTS.md)
fi

# ---- 执行审查：JSON 落盘，进度走 stderr ----
# 说明：规则与排除项由 .opencodereview/rule.json 自动加载（ocr 项目级约定），
#       审查背景见上方 bg_args（AGENTS.md，或与 OCR_BACKGROUND 合成），--audience agent 减少进度噪音。
info "启动 ocr 审查（范围：$scope_desc；effort=$EFFORT，预算 ${TIMEOUT_MIN}min）——审查维度：简洁性/架构/复用/维护/可读性 + 项目规范..."
if ! ${REVIEW_TO[@]+"${REVIEW_TO[@]}"} ocr review \
    --audience agent \
    --format json \
    ${bg_args[@]+"${bg_args[@]}"} \
    --effort "$EFFORT" \
    --timeout "$TIMEOUT_MIN" \
    --output "$json_file" \
    ${target[@]+"${target[@]}"} >&2; then
  warn "ocr 执行失败/超时（provider 未配置或网络问题？），本次放行"
  warn "排查：ocr llm test    配置：ocr config provider"
  exit 0
fi

# ---- 自动归档：从结果信封取 session_id，导出自包含 HTML 报告 ----
# 非致命环节：目录创建/导出任何失败只提示不改变审查结论（set -e 下须显式容错）
archive_path=""
if session_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("session_id") or "")' "$json_file" 2>/dev/null)" \
   && [[ -n "$session_id" ]]; then
  if ! mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
    warn "归档目录不可创建（$ARCHIVE_DIR），跳过归档（不影响审查结论）"
  else
    # 文件名带 PID 防同秒碰撞（批量提交时两次审查落在同一秒会互相截断）
    archive_path="$ARCHIVE_DIR/$(date +%Y%m%d-%H%M%S)-$$${archive_tag}.html"
    if ${EXPORT_TO[@]+"${EXPORT_TO[@]}"} ocr session export "$session_id" >"$archive_path" 2>/dev/null; then
      # 按修改时间保留最近 ARCHIVE_KEEP 份，删除更旧归档（|| true 防空目录 glob 失败触发 set -e）
      ls -1t "$ARCHIVE_DIR"/*.html 2>/dev/null | tail -n +"$((ARCHIVE_KEEP + 1))" | while read -r f; do rm -f "$f"; done || true
    else
      rm -f "$archive_path"
      archive_path=""
      warn "HTML 报告归档失败（不影响审查结论），可手动导出：ocr session export $session_id"
    fi
  fi
fi

# ---- 解析结果（python3；退出码约定：0=放行 1=有阻断级发现 2=解析异常）----
# 临时关闭 set -e 以显式捕获 python 退出码
set +e
python3 - "$json_file" "$BLOCK_SEVERITIES" >"$render_file" <<'PYEOF'
import json
import sys

try:
    # 读取 ocr 的 JSON 信封：{status, summary{files_reviewed,comments,...}, comments:[...]}
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
except Exception as exc:  # JSON 缺失/损坏 → 交由外层降级放行
    print(f"结果文件解析失败: {exc}", file=sys.stderr)
    sys.exit(2)

block = {s.strip().lower() for s in sys.argv[2].split() if s.strip()}
sev_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
sev_icon = {"critical": "🔴", "high": "🟠", "medium": "🟡", "low": "⚪"}
cat_zh = {
    "bug": "缺陷", "security": "安全", "performance": "性能",
    "maintainability": "可维护性", "test": "测试", "style": "风格",
    "documentation": "文档", "other": "其他",
}

comments = data.get("comments") or []
summary = data.get("summary") or {}
blocked = [c for c in comments if (c.get("severity") or "").lower() in block]

# 会话状态非 complete（中断/失败/部分完成）→ 结果不可信：退出码 2 交由外层降级放行，
# 绝不把「审查没跑完」报告成「无阻断级发现」的绿灯
status = (data.get("status") or "").lower()
if status and status not in ("complete", "completed"):
    print(f"—— 会话状态异常（status={status}），结果不完整，本次按「无法判定」放行")
    sys.exit(2)

# 按严重级别从高到低渲染每条发现：图标 [级别|分类] 位置 + 内容摘要
for c in sorted(comments, key=lambda c: sev_rank.get((c.get("severity") or "").lower(), 9)):
    sev = (c.get("severity") or "unknown").lower()
    cat = cat_zh.get(c.get("category") or "", c.get("category") or "未分类")
    path = c.get("path") or "?"
    start = c.get("start_line") or 0
    end = c.get("end_line") or start
    loc = f"{path}:{start}" if start and start == end else (
        f"{path}:{start}-{end}" if start else path)
    print(f"{sev_icon.get(sev, '⚪')} [{sev.upper()}|{cat}] {loc}")
    content = (c.get("content") or "").strip().replace("\n", "\n   ")
    print(f"   {content[:600]}")
    if len(content) > 600:
        print("   ……（完整内容：ocr session list 查看）")

print(f"—— 共审查 {summary.get('files_reviewed', '?')} 个文件，"
      f"发现 {len(comments)} 条（阻断级 {len(blocked)}），"
      f"tokens {summary.get('total_tokens', '?')}，status={data.get('status', '?')}")

sys.exit(1 if blocked else 0)
PYEOF
parse_rc=$?
set -e

# ---- 按解析退出码分派 ----
case "$parse_rc" in
  0)
    cat "$render_file"
    [[ -n "$archive_path" ]] && info "报告已归档: $archive_path"
    info "AI 审查通过：无阻断级发现（中低级提醒见上，可自行斟酌处理）"
    exit 0
    ;;
  1)
    cat "$render_file"
    [[ -n "$archive_path" ]] && info "报告已归档: $archive_path"
    fail "存在阻断级发现（${BLOCK_SEVERITIES}），提交被阻止"
    fail "→ 修复后重新提交；或 git commit --no-verify / SKIP_AI=1 强行通过（慎用）"
    exit 1
    ;;
  *)
    warn "审查结果解析异常（rc=$parse_rc），无法判定，本次放行"
    exit 0
    ;;
esac
