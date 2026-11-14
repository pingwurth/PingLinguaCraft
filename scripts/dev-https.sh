#!/usr/bin/env bash
# dev-https.sh —— 为局域网访问签发本地 HTTPS 证书，并以「next start + TLS 反代」启动
#
# 为什么需要 HTTPS：手机浏览器的媒体录音（MediaRecorder）、Service Worker（PWA）
# 都要求安全上下文；局域网 http://IP 无法满足。用 mkcert 给局域网 IP/主机名签发
# 本地信任证书后，手机安装 mkcert 根证书一次即可长期使用。
#
# 为什么走反向代理：next start 不支持 --experimental-https-key/--experimental-https-cert
# （那是 next dev 的专属参数，传了会直接报 unknown option 退出）。因此 next start
# 跑 127.0.0.1:3000（HTTP，仅回环），由 scripts/https-proxy.mjs 在 0.0.0.0:<PORT>
# 终止 TLS 后字节级透传——Range/206 流式语义与裸 next start 完全一致。
#
# 用法：
#   ./scripts/dev-https.sh [代理端口]      # 默认 3443（上游固定 127.0.0.1:3000）
# 环境变量：
#   LAN_IP=192.168.x.x   ./scripts/dev-https.sh   # 多网卡机器显式指定局域网 IP
# 前置：
#   1) 安装 mkcert（deepin/Debian: sudo apt install mkcert 或 brew install mkcert）
#   2) 运行 mkcert -install（本机信任）
#   3) 手机端：访问 http://mkcert 下载根证书并安装（或在电脑上 mkcert -CAROOT
#      找到 rootCA.pem 传给手机安装），iOS 需在 设置→通用→关于本机→证书信任设置
#      里手动开启完全信任
set -euo pipefail

# 端口与路径
PORT="${1:-3443}"
UPSTREAM="http://127.0.0.1:3000"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/certs"
RUN_DIR="$HOME/.pinglc/run"
source "$ROOT/scripts/lib.sh"
mkdir -p "$RUN_DIR"

# 探测局域网 IPv4：优先常见局域网网段（192.168./10.），172 私有网段兜底时排除
# docker0 默认的 172.17（多网卡机器首个地址常是它，签给它手机必然连不上）；
# 探测不可信时用 LAN_IP 环境变量显式指定
# 正则注意：192.168 段须写 '192\.168\.[0-9]+\.'（点后跟数字）——写成
# '^(192\.168|10\.)[0-9]+\.' 会在 192.168 后要求紧跟数字，实际是 "."，永远匹配不上
LAN_IP="${LAN_IP:-}"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168\.[0-9]+|10\.[0-9]+)\.' | head -n 1 || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^172\.(1[6-9]|2[0-9]|3[01])\.' | grep -v '^172\.17\.' | head -n 1 || true)"
fi
if [[ -z "$LAN_IP" ]]; then
  echo "未探测到可信的局域网 IPv4。请显式指定后重试：LAN_IP=192.168.x.x $0" >&2
  exit 1
fi

echo "局域网 IP: ${LAN_IP}"

# 检查 mkcert
if ! command -v mkcert >/dev/null 2>&1; then
  echo "未安装 mkcert。请先安装：sudo apt install mkcert && mkcert -install" >&2
  exit 1
fi

# 签发证书（覆盖旧证书；含 localhost 与局域网 IP 两个 SAN）
mkdir -p "$CERT_DIR"
mkcert -install
mkcert -cert-file "$CERT_DIR/dev.crt" -key-file "$CERT_DIR/dev.key" \
  "localhost" "$LAN_IP" "$(hostname)"

echo "证书已生成于 $CERT_DIR（已加入 .gitignore，不会入库）"

# 生产构建判定看 .next/BUILD_ID：next dev 与被打断的 next build 都会留下
# 没有 BUILD_ID 的 .next 目录，只看目录存在会误判跳过构建
cd "$ROOT/apps/web"
if [[ ! -f ".next/BUILD_ID" ]]; then
  echo "未发现有效生产构建（缺 .next/BUILD_ID），先执行 pnpm build ..."
  pnpm build
fi

# 后台启动上游 next start（HTTP 仅回环）：lib.sh 的 spawn_group（与 start.sh 共用），
# 退出/中断时按进程组整体回收——只 kill 包装进程会留下 next-server 孙进程占着 3000
# 启动前先探 3000 端口：已被占用时 next start 会立刻 EADDRINUSE 退出，而 wait_http
# 会把占用者误当上游「就绪」，手机流量被静默转发到别人的进程上
if [[ -n "$(port_pid 3000)" ]]; then
  echo "端口 3000 已被占用（可能是 ./scripts/start.sh 的 dev 服务在跑）。dev-https 需要 next start 独占 3000，请先停掉占用者（./scripts/stop.sh）再试。" >&2
  exit 1
fi
echo "启动上游 next start（127.0.0.1:3000）..."
UPSTREAM_PID_FILE="$RUN_DIR/dev-https-upstream.pid"
spawn_group "$UPSTREAM_PID_FILE" "$RUN_DIR/dev-https-upstream.log" \
  pnpm exec next start -H 127.0.0.1 -p 3000
cleanup() {
  local pid
  pid="$(alive_pid "$UPSTREAM_PID_FILE")"
  if [[ -n "$pid" ]]; then
    kill_group "$pid" || true
    rm -f "$UPSTREAM_PID_FILE"
  fi
}
trap cleanup EXIT

# 等上游就绪再启动代理：next start 刚拉起尚未监听时，手机第一波请求会全部 502
echo "等待上游就绪（最长 60s）..."
if ! wait_http "$UPSTREAM" 60; then
  echo "上游 60s 内未就绪，最近日志：" >&2
  tail -n 20 "$RUN_DIR/dev-https-upstream.log" >&2 || true
  exit 1
fi

echo ""
echo "手机访问: https://${LAN_IP}:${PORT}  （首次需安装 mkcert 根证书，见脚本头部说明）"
echo "按 Ctrl+C 停止（next start 与代理一并退出）"
# 前台运行 TLS 代理；其退出后由上方 EXIT trap 按进程组回收上游
node "$ROOT/scripts/https-proxy.mjs" "$PORT" "$UPSTREAM" "$CERT_DIR/dev.key" "$CERT_DIR/dev.crt"
