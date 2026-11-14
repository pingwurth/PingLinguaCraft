#!/usr/bin/env bash
# lib.sh —— 服务脚本共享函数库（start.sh / stop.sh / dev-https.sh source 复用）
#
# 为什么存在：端口探测与 PID 校验逻辑此前在 start.sh / stop.sh 各有一份且已开始
# 漂移（可移植性修复只落在其中一份）。收敛为单一事实源，改一处全体生效。
#
# 可移植性：主径面向 Linux（ss/procfs）；macOS 等环境自动回退 lsof / 跳过
# procfs 校验，探测不到时返回空/真值由调用方决定后续动作。
#
# 用法：source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# ---- 探测占用某端口的进程 PID（无占用输出空串）----
# 主径 ss（Linux iproute2，仅能看到本用户监听的 pid=）；缺失或无结果时回退 lsof
port_pid() { # $1=端口号
  local pid=""
  if command -v ss >/dev/null 2>&1; then
    pid="$(ss -ltnp "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  fi
  if [[ -z "$pid" ]] && command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -tniTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  fi
  echo "$pid"
}

# ---- 校验 PID 文件：内容为正整数且进程仍存活则输出 PID，否则清理失效文件 ----
# 内容必须为纯数字且 > 1（防「0」之类异常值：kill -0 0 恒真、负 PID 组杀会指向自身）
alive_pid() { # $1=PID 文件路径
  local pf="$1" p
  [[ -f "$pf" ]] || return 0
  p="$(cat "$pf" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$p" =~ ^[1-9][0-9]*$ ]] && kill -0 "$p" 2>/dev/null; then
    echo "$p"
  else
    rm -f "$pf"
  fi
}

# ---- 进程命令行是否匹配模式（组杀前的安全校验，防 PID 复用误杀无辜进程组）----
# 读 /proc/<pid>/cmdline（Linux）；非 Linux 无 procfs 时跳过校验（返回真）
pid_matches() { # $1=PID  $2=扩展正则（如 'uvicorn|next|pnpm'）
  [[ -d /proc ]] || return 0
  local cmd
  cmd="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true)"
  [[ -n "$cmd" && "$cmd" =~ $2 ]]
}

# ---- 取进程所在进程组 ID（PGID）；进程不在时输出空串 ----
pgid_of() { # $1=PID
  ps -o pgid= -p "$1" 2>/dev/null | tr -d '[:space:]' || true
}

# ---- 按进程组终止：TERM 优雅 → 最长 10s → KILL 强杀；确认退出返回 0 ----
# 按组（负 PGID）整体终止，连带清理 pnpm/uv 派生的子进程，不留孤儿
kill_group() { # $1=PID（以该进程所在 PGID 为目标）
  local pid="$1" pgid waited=0
  pgid="$(pgid_of "$pid")"
  [[ -n "$pgid" ]] || return 1
  kill -TERM -- "-$pgid" 2>/dev/null || true
  while (( waited < 10 )); do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
  sleep 1
  kill -0 -- "-$pgid" 2>/dev/null && return 1 || return 0
}

# ---- 等待 HTTP 服务就绪：成功返回 0；超时返回 1（调用方自行打印日志提示）----
# 有 curl 用 curl（任意状态码都算已监听）；无 curl 回退 bash /dev/tcp 连通性探测
wait_http() { # $1=探测 URL  $2=最长等待秒数
  local url="$1" limit="$2" waited=0 host port
  host="$(sed -E 's#^https?://##; s#[/:].*##' <<<"$url")"
  port="$(sed -E 's#^https?://[^:/]+:?##; s#/.*##' <<<"$url")"
  port="${port:-80}"
  while (( waited < limit )); do
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null --max-time 2 "$url" && return 0
    else
      # TCP 能连通即视为服务已监听（够用：调用方探测的都是本机回环/局域网地址）
      (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null && return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# ---- 以独立进程组后台启动一个服务（start.sh 与 dev-https.sh 共用）----
# 参数：$1=pid文件 $2=日志文件 $3...=完整命令；成功返回 0
# 说明：内层 bash 先把自身 PID（即新会话/进程组首进程）写入 pid 文件再 exec，
#       无论 setsid 是否 fork，写入的都是可靠的组长 PID；调用方用负 PID 杀整组。
#       启动后轮询 3s 确认 pid 文件已落盘——spawn 失败（如命令不存在）在此暴露，
#       否则 pid 文件永远不出现，调用方的回收逻辑找不到目标，进程成孤儿。
spawn_group() { # $1=pid文件 $2=日志文件 $3...=完整命令
  local pidfile="$1" logfile="$2"; shift 2
  if ! command -v setsid >/dev/null 2>&1; then
    echo "[lib] 未安装 setsid（util-linux），无法以独立进程组启动——请安装后重试" >&2
    return 1
  fi
  : >"$logfile" # 清空旧日志，每次启动一个新文件
  setsid bash -c 'echo $$ > "$1"; shift; exec "$@" >>"$0" 2>&1' \
    "$logfile" "$pidfile" "$@" &
  local waited=0
  while (( waited < 3 )); do
    [[ -s "$pidfile" ]] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  echo "[lib] 启动后 3s 内未见 PID 文件生成（$pidfile），最近日志：" >&2
  tail -n 10 "$logfile" >&2 || true
  return 1
}
