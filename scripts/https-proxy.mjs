/**
 * 本地 HTTPS 反向代理（dev-https.sh 的 TLS 终止层）
 *
 * next start 不支持 --experimental-https-key/--experimental-https-cert
 * （那是 next dev 的专属参数，传给 next start 会以 unknown option 退出）。
 * 因此生产服务跑在 127.0.0.1:3000（HTTP，仅本机回环），由本代理在
 * 局域网 0.0.0.0:<port> 终止 TLS（mkcert 证书）后原样转发——
 * 请求/响应均为字节级透传，/api/media 的 Range/206 流式语义不受影响。
 *
 * 健壮性设计：
 * - 端口参数校验（1-65535 整数）；监听错误（端口被占等）给人话提示而非栈回溯
 * - 已开始回传的响应（如 206 流式）出上游错误时只能销毁连接截断，
 *   绝不追加诊断文本——文本拼进二进制媒体流会损坏客户端收到的文件
 * - 客户端中断时连带断开上游 socket，避免上游写向死连接
 * - 上游空闲超时（不限制长流媒体的持续传输，只防挂死）
 * - 原始 Host/协议经 x-forwarded-* 传递，上游生成绝对 URL/重定向时不至于指向回环地址
 *
 * 用法：node https-proxy.mjs <监听端口> <上游URL> <TLS key 路径> <TLS cert 路径>
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

// 命令行参数：端口 / 上游地址 / TLS 私钥与证书路径
const [portArg, upstreamArg, keyPath, certPath] = process.argv.slice(2);

if (!portArg || !upstreamArg || !keyPath || !certPath) {
  console.error('用法: node https-proxy.mjs <端口> <上游URL> <TLS key 路径> <TLS cert 路径>');
  process.exit(1);
}

/** 监听端口（局域网 0.0.0.0）——校验后再使用，非法值在 listen 时只会得到难懂的 ERR_SOCKET_BAD_PORT */
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`端口非法: "${portArg}"（须为 1-65535 的整数）`);
  process.exit(1);
}

/** 上游服务地址（next start，如 http://127.0.0.1:3000）；畸形输入给人话提示而非 TypeError 栈 */
let upstream;
try {
  upstream = new URL(upstreamArg);
} catch {
  console.error(`上游 URL 非法: "${upstreamArg}"（须为 http://host:port 形式）`);
  process.exit(1);
}

/** 读取 TLS 材料；文件缺失（certs/ 被清理后重跑等）给人话提示而非 ENOENT 栈 */
let tlsOptions;
try {
  tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
} catch (err) {
  console.error(`TLS 证书/私钥读取失败（${keyPath} / ${certPath}）: ${err.message}`);
  process.exit(1);
}

/** 上游 socket 空闲超时：只防挂死，不限制长流媒体的持续传输 */
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * TLS 代理服务器：请求透传至上游，响应原样回传
 * @param req  入站请求（含 Range 等头，原样转发）
 * @param res  出站响应（上游状态码与响应头不加工）
 */
const server = https.createServer(
  tlsOptions,
  (req, res) => {
    // 转发头：host 改写为上游（路由需要），原始来源经 x-forwarded-* 透传——
    // 上游将来生成重定向/绝对 URL/Secure cookie 时能感知真实协议与主机
    const headers = {
      ...req.headers,
      host: upstream.host,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': String(req.headers.host ?? ''),
      'x-forwarded-for': String(req.socket.remoteAddress ?? ''),
    };
    const proxied = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers,
        timeout: UPSTREAM_IDLE_TIMEOUT_MS,
      },
      (upstreamRes) => {
        // 上游状态码与响应头原样回传（Content-Range/Content-Length/Accept-Ranges 不加工）
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        // 上游响应流中途出错（next start 崩溃/断开）：只能截断，不追加文本
        upstreamRes.on('error', () => res.destroy());
      }
    );
    // 上游连接阶段出错（未就绪/已退出）：未回传时给可读的 502；已回传只能截断
    proxied.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`上游不可达 (${upstream.href}): ${err.message}`);
      } else {
        res.destroy();
      }
    });
    // 空闲超时：销毁上游连接（上面的 error 处理负责收尾下游）
    proxied.on('timeout', () => proxied.destroy(new Error(`上游空闲超时 (${UPSTREAM_IDLE_TIMEOUT_MS}ms)`)));
    // 入站请求流出错（手机弱网中断上传，ECONNRESET）：pipe 不转发源错误，
    // 不挂监听会成为未捕获异常带走整个代理进程
    req.on('error', () => proxied.destroy());
    // 客户端中断：连带断开上游，避免上游 socket 继续写向死连接
    res.on('close', () => proxied.destroy());
    req.pipe(proxied);
  }
);

// 监听层错误（端口被占/权限不足等）：人话提示后退出，而非未捕获异常栈
server.on('error', (err) => {
  console.error(`代理监听失败（端口 ${port}）: ${err.message}`);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`HTTPS 代理已启动: https://0.0.0.0:${port} → ${upstream.href}`);
});

/* Ctrl+C / 终止信号：优雅关闭监听后退出（上游进程由 dev-https.sh 的 trap 回收） */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
