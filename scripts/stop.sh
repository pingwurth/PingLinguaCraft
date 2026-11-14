#!/usr/bin/env bash
# stop.sh —— 停止 start.sh 启动的后台服务（web / ai-engine）
#
# 停止策略：
#   1) 优先按 ~/.pinglc/run/ 下的 PID 文件找到进程组，先 SIGTERM 优雅终止，
#      10s 未退出再 SIGKILL 强杀——按进程组（负 PGID）整体终止，
#      连带清理 pnpm/uv/next dev 派生的全部子进程
#   2) PID 文件内容做安全校验（纯数字 >1 且 /proc 命令行命中本服务进程特征），
#      防 PID 复用后负 PID 组杀误伤无关进程组；校验不过则丢弃 PID 文件并告警
#   3) PID 文件丢失但端口仍被占用时，回退按端口探测 PID，同样校验后按其进程组终止
#
# 用法：
#   ./scripts/stop.sh            # 停止全部（web + engine）
#   ./scripts/stop.sh engine     # 仅停止 AI 引擎
#   ./scripts/stop.sh web        # 仅停止 Web
#   ./scripts/stop.sh status     # 只查看运行状态，不做任何操作
set -euo pipefail

RUN_DIR="$HOME/.pinglc/run"
ENGINE_PORT=8765
WEB_PORT=3000
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# ---- 状态输出 ----
info() { printf '\033[1;34m[停止]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[已停止]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[未运行]\033[0m %s\n' "$*"; }

# ---- 停止单个服务：$1=服务名 $2=端口 $3=进程特征正则（组杀前校验用）----
stop_one() {
  local name="$1" port="$2" pattern="$3" pid
  pid="$(alive_pid "$RUN_DIR/$name.pid")"
  if [[ -n "$pid" ]]; then
    if ! pid_matches "$pid" "$pattern"; then
      warn "$name PID 文件指向的进程（$pid）命令行不匹配本服务（疑似 PID 复用），丢弃 PID 文件不做终止"
      rm -f "$RUN_DIR/$name.pid"
      return 0
    fi
    info "$name（进程组 $(pgid_of "$pid")）发送 SIGTERM ..."
    if kill_group "$pid"; then
      ok "$name"
    else
      info "$name 强杀后仍存活，请手动检查：ps -o pgid= -p $pid"
      return 1
    fi
    rm -f "$RUN_DIR/$name.pid"
    return 0
  fi

  # 回退：PID 文件不在，但端口仍被占用——校验进程特征后终止
  # 安全约束：只有「PID == 自己的 PGID」（组长，即 setsid 拉起的独立组）才按组杀；
  # 手动在终端跑的 next dev/pnpm dev 与终端共享进程组，负 PID 组杀会波及终端会话
  local holder
  holder="$(port_pid "$port")"
  if [[ -n "$holder" ]]; then
    if ! pid_matches "$holder" "$pattern"; then
      warn "端口 $port 被 PID $holder 占用但特征不匹配（非本脚本管理的服务），不动它——请自行确认后处理"
      return 0
    fi
    if [[ "$(pgid_of "$holder")" == "$holder" ]]; then
      info "$name 无 PID 文件，端口 $port 被 PID $holder 占用（独立进程组），按组终止 ..."
      if kill_group "$holder"; then
        ok "$name（按端口清理 PID $holder）"
      else
        warn "PID $holder 强杀后仍存活，请手动检查"
        return 1
      fi
    else
      info "$name 无 PID 文件，端口 $port 被 PID $holder 占用（与终端共享进程组，只能杀单进程）..."
      kill -TERM "$holder" 2>/dev/null || true
      sleep 2
      kill -0 "$holder" 2>/dev/null && kill -KILL "$holder" 2>/dev/null || true
      ok "$name（单进程清理 PID $holder；其子进程请用 ps --ppid $holder 确认）"
    fi
    return 0
  fi

  warn "$name（本机无运行实例）"
}

# ---- 查看运行状态 ----
show_status() {
  local name port pid
  for spec in "engine $ENGINE_PORT" "web $WEB_PORT"; do
    read -r name port <<<"$spec"
    pid="$(alive_pid "$RUN_DIR/$name.pid")"
    if [[ -n "$pid" ]]; then
      printf '  %-8s 运行中  PID %s\n' "$name" "$pid"
    else
      local holder; holder="$(port_pid "$port")"
      if [[ -n "$holder" ]]; then
        printf '  %-8s 端口 %s 被外部进程 PID %s 占用（非本脚本管理）\n' "$name" "$port" "$holder"
      else
        printf '  %-8s 未运行\n' "$name"
      fi
    fi
  done
}

# ---- 参数分发 ----
# 特征正则锚定匹配（防子串误命中：裸 'uv' 会匹配 /opt/uva-tools/…，裸 'node' 会匹配任意 node 进程）
case "${1:-all}" in
  all)    stop_one web "$WEB_PORT" 'next-server|next dev|@pinglc/web|pnpm.*dev'
          stop_one engine "$ENGINE_PORT" 'uvicorn|(^|/)uv( |$)' ;;
  engine) stop_one engine "$ENGINE_PORT" 'uvicorn|(^|/)uv( |$)' ;;
  web)    stop_one web "$WEB_PORT" 'next-server|next dev|@pinglc/web|pnpm.*dev' ;;
  status) show_status ;;
  *) echo "用法: $0 [all|engine|web|status]" >&2; exit 2 ;;
esac
