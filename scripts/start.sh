#!/usr/bin/env bash
# start.sh —— 一键后台启动 PingLinguaCraft 开发服务（web + ai-engine）
#
# 启动内容：
#   engine : AI 引擎 uvicorn（仅监听 127.0.0.1:8765）
#   web    : Web 应用 next dev（http://localhost:3000）
#
# 设计要点：
#   1) 运行文件（PID/日志）统一放 ~/.pinglc/run/，符合「一切用户数据在 ~/.pinglc/」约定
#   2) 服务以独立进程组（setsid）后台启动，stop.sh 按进程组整体终止，
#      可连带清理 pnpm/uv 派生的子进程，不留孤儿；健康检查失败同样回收已拉起的进程组
#   3) 启动后轮询健康检查（engine 探 /health，web 探 3000 端口响应），
#      就绪才报成功，避免「起了但没起来」的假象
#   4) 端口探测/PID 校验等共享逻辑收敛在 scripts/lib.sh（与 stop.sh 单一事实源）
#
# 用法：
#   ./scripts/start.sh            # 启动全部（engine + web）
#   ./scripts/start.sh engine     # 仅启动 AI 引擎
#   ./scripts/start.sh web        # 仅启动 Web
#   SKIP_WAIT=1 ./scripts/start.sh   # 后台拉起即返回，不等待健康检查
# 手机联调（HTTPS / PWA / 录音）请改用 ./scripts/dev-https.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
RUN_DIR="$HOME/.pinglc/run"          # 运行时 PID 与日志目录
ENGINE_PORT=8765
WEB_PORT=3000
mkdir -p "$RUN_DIR"

# ---- 状态输出（带色，便于在长日志里一眼定位）----
info() { printf '\033[1;34m[启动]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[就绪]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[跳过]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[失败]\033[0m %s\n' "$*" >&2; }

# ---- 以独立进程组后台启动：lib.sh 的 spawn_group（与 dev-https.sh 共用同一实现）----

# ---- 启动失败回收：按进程组终止刚拉起的进程并清理 PID 文件 ----
cleanup_failed_spawn() { # $1=服务名
  local pid
  pid="$(alive_pid "$RUN_DIR/$1.pid")"
  if [[ -n "$pid" ]]; then
    info "$1 健康检查失败，回收已拉起的进程组（PID $pid）..."
    kill_group "$pid" || true
    rm -f "$RUN_DIR/$1.pid"
  fi
}

# ---- 启动 AI 引擎 ----
start_engine() {
  local pid
  pid="$(alive_pid "$RUN_DIR/engine.pid")"
  if [[ -n "$pid" ]]; then
    warn "engine 已在运行（PID $pid），日志 $RUN_DIR/engine.log"
    return 0
  fi
  local holder
  holder="$(port_pid "$ENGINE_PORT")"
  if [[ -n "$holder" ]]; then
    fail "端口 $ENGINE_PORT 已被 PID $holder 占用（非本脚本管理），请先处理后再启动"
    return 1
  fi
  command -v uv >/dev/null 2>&1 || {
    fail "未安装 uv，请先运行 ./scripts/engine-setup.sh"
    return 1
  }
  info "启动 AI 引擎（uvicorn 127.0.0.1:$ENGINE_PORT）..."
  spawn_group "$RUN_DIR/engine.pid" "$RUN_DIR/engine.log" \
    uv run --directory "$ROOT/services/ai-engine" \
    uvicorn app.main:app --host 127.0.0.1 --port "$ENGINE_PORT" || return 1
  if [[ "${SKIP_WAIT:-0}" == "1" ]]; then
    info "engine 后台拉起（跳过等待）"
    return 0
  fi
  if wait_http "http://127.0.0.1:$ENGINE_PORT/health" 90; then
    ok "engine 已就绪: http://127.0.0.1:$ENGINE_PORT/health"
    return 0
  fi
  fail "engine 90s 内未就绪，最近日志："
  tail -n 20 "$RUN_DIR/engine.log" >&2 || true
  cleanup_failed_spawn engine
  return 1
}

# ---- 启动 Web 应用 ----
start_web() {
  local pid
  pid="$(alive_pid "$RUN_DIR/web.pid")"
  if [[ -n "$pid" ]]; then
    warn "web 已在运行（PID $pid），日志 $RUN_DIR/web.log"
    return 0
  fi
  local holder
  holder="$(port_pid "$WEB_PORT")"
  if [[ -n "$holder" ]]; then
    fail "端口 $WEB_PORT 已被 PID $holder 占用（非本脚本管理），请先处理后再启动"
    return 1
  fi
  info "启动 Web 应用（next dev :$WEB_PORT）..."
  spawn_group "$RUN_DIR/web.pid" "$RUN_DIR/web.log" \
    pnpm --dir "$ROOT" --filter @pinglc/web dev || return 1
  if [[ "${SKIP_WAIT:-0}" == "1" ]]; then
    info "web 后台拉起（跳过等待）"
    return 0
  fi
  if wait_http "http://localhost:$WEB_PORT" 90; then
    ok "web 已就绪: http://localhost:$WEB_PORT"
    return 0
  fi
  fail "web 90s 内未就绪，最近日志："
  tail -n 20 "$RUN_DIR/web.log" >&2 || true
  cleanup_failed_spawn web
  return 1
}

# ---- 参数分发 ----
# 注意：all 分支用「|| exit 1」显式传播失败——`A && B` 形式下 A 失败不触发 set -e，
# 脚本会带着误导性的成功提示以 0 退出
case "${1:-all}" in
  all)    start_engine || exit 1
          start_web ;;
  engine) start_engine ;;
  web)    start_web ;;
  *) echo "用法: $0 [all|engine|web]" >&2; exit 2 ;;
esac

echo ""
echo "日志目录: $RUN_DIR   停止服务: ./scripts/stop.sh"
