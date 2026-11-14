#!/usr/bin/env bash
# ai-review.sh —— AI 代码审查封装（基于 alibaba/open-code-review，命令 ocr）
#
# 作用：对代码变更做语义级 AI 审查——简洁性、架构设计、复用性、维护性、
#       可读性，以及项目自定义规范（.opencodereview/rule.json 按路径分层
#       定义了四工作区的纪律，AGENTS.md 作为审查背景喂入）。
#
# 拦截策略：severity 命中 BLOCK_SEVERITIES（默认 critical/high）→ 退出码 1
#           阻止提交；中低级别仅打印提醒。逃生口：SKIP_AI=1 或 --no-verify。
#
# 自动归档：每次审查成功后，将完整 HTML 报告归档到 ~/.pinglc/reviews/
#           （命名：时间戳[-commit短哈希].html），仅保留最近 ARCHIVE_KEEP 份；
#           归档失败不影响审查结论（非致命）。
#
# 降级原则：AI 层是「增强」而非「硬依赖」——ocr 未安装、provider 未配置、
#           网络/模型故障、超时、结果解析失败，一律黄字提示后放行（退出码 0），
#           绝不因基础设施问题卡死提交流程；只有「确认的阻断级发现」才挡提交。
#
# 用法：
#   ./scripts/ai-review.sh                   # 审查工作区全部变更（staged+unstaged+untracked）
#   ./scripts/ai-review.sh --commit abc123   # 审查某个 commit
#   SKIP_AI=1 ./scripts/ai-review.sh         # 跳过
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
TIMEOUT_MIN=10                     # ocr 并发任务预算（分钟）
WALL_CLOCK=$((TIMEOUT_MIN * 60 + 120))  # 整体墙钟上限（秒）：任务预算 + 2min 余量，
                                     # 保证 ocr 自身预算先到期并正常落盘结果，而非被外层截杀
ARCHIVE_DIR="${OCR_ARCHIVE_DIR:-$HOME/.pinglc/reviews}"  # HTML 报告归档目录（遵循「一切用户数据在 ~/.pinglc/」约定）
ARCHIVE_KEEP="${OCR_ARCHIVE_KEEP:-50}"  # 归档保留份数，超出删最旧

# ---- 状态输出 ----
info() { printf '\033[1;34m[AI审]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[AI审]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[AI审]\033[0m %s\n' "$*" >&2; }

# ---- 逃生口 ----
if [[ "${SKIP_AI:-0}" == "1" || "${SKIP_GATES:-0}" == "1" ]]; then
  warn "SKIP_AI/SKIP_GATES=1，跳过 AI 代码审查"
  exit 0
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

# ---- 参数 → ocr review 目标（默认 workspace 模式：staged+unstaged+untracked）----
target=()
commit_hash=""
if [[ "${1:-}" == "--commit" && -n "${2:-}" ]]; then
  target=(--commit "$2")
  commit_hash="-commit-${2:0:7}"
elif [[ $# -gt 0 ]]; then
  echo "用法: $0 [--commit <hash>]" >&2
  exit 2
fi

# ---- 临时文件：ocr 的 JSON 输出 + 渲染结果（模板不带后缀——BSD mktemp 要求 X 结尾）----
json_file="$(mktemp /tmp/pinglc-ai-review.XXXXXX)"
render_file="$(mktemp /tmp/pinglc-ai-render.XXXXXX)"
trap 'rm -f "$json_file" "$render_file"' EXIT

# ---- 执行审查：JSON 落盘，进度走 stderr ----
# 说明：规则与排除项由 .opencodereview/rule.json 自动加载（ocr 项目级约定），
#       AGENTS.md 作为规范背景喂入，--audience agent 减少进度噪音。
info "启动 ocr 审查（effort=$EFFORT，预算 ${TIMEOUT_MIN}min）——审查维度：简洁性/架构/复用/维护/可读性 + 项目规范..."
if ! ${REVIEW_TO[@]+"${REVIEW_TO[@]}"} ocr review \
    --audience agent \
    --format json \
    --background-file AGENTS.md \
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
    archive_path="$ARCHIVE_DIR/$(date +%Y%m%d-%H%M%S)-$$${commit_hash}.html"
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
