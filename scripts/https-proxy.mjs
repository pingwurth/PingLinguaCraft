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
 * - 入站/出站两个方向的流都挂 error 监听（客户端半途断开产生的 EPIPE
 *   不挂监听会成为未捕获异常，带崩整个代理进程）
 * - 回传用手动泵替代 pipe：背压（客户端 TCP 窗收拢）时暂停上游读，
 *   并在背压期间豁免空闲超时——下游慢不等于上游挂死，30s 定时器
 *   否则会误杀健康的媒体流
 * - 客户端中断时连带断开上游 socket，避免上游写向死连接
 * - 上游空闲超时（不限制长流媒体的持续传输，只防挂死）
 * - 原始 Host/协议经 x-forwarded-* 传递，上游生成绝对 URL/重定向时不至于指向回环地址
 * - 优雅停机有界：server.close 默认要等所有连接（含播放中的媒体流）自然结束
 *   才回调——可能永不退出；宽限期后强制断开残余连接并兜底硬退出
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

/** 背压最长等待：下游持续不读（息屏/半开连接/零窗口不恢复）超过该墙钟即按挂死销毁
 *  （socket 的空闲计时器只在新读写活动时重挂，彻底暂停期间 'timeout' 至多触发
 *   一次，不能靠它做有界豁免——见回传泵处的说明） */
const BP_MAX_WAIT_MS = 3 * UPSTREAM_IDLE_TIMEOUT_MS;

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
    // 背压状态：backpressured=下游写缓冲满、正在等 drain（此时上游读已暂停）；
    // bpDeadline=背压兜底销毁定时器（见回传泵处说明）。声明在请求处理器顶层，
    // timeout 处理器据此豁免背压期的空闲超时
    let backpressured = false;
    let bpDeadline = null;
    // 背压解除的统一收尾（drain/流结束/下游出错三处共用）：清标记 + 清兜底定时器
    const clearBackpressure = () => {
      backpressured = false;
      if (bpDeadline) {
        clearTimeout(bpDeadline);
        bpDeadline = null;
      }
    };
    // 重挂上游 socket 的空闲计时器：'timeout' 触发后计时器不会自动重挂（只在新
    // 读写活动时重挂），彻底暂停期间至多触发一次——不重挂的话，下游恢复读取而
    // 上游恰好挂死（drain→resume 后无字节流量）时再无机制能触发超时，请求悬死
    const rearmIdleTimer = () => {
      proxied.socket?.setTimeout?.(UPSTREAM_IDLE_TIMEOUT_MS);
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
        // 回传泵：手动转发替代 pipe——需要感知背压以豁免空闲超时（见下方 timeout 处理）
        upstreamRes.on('data', (chunk) => {
          if (res.write(chunk)) return;
          // 写缓冲满：暂停上游读，待下游排空再续——期间上游 socket 空闲属正常
          backpressured = true;
          upstreamRes.pause();
          // 背压兜底：下游持续不读时靠该墙钟定时器按挂死销毁（客户端息屏/半开
          // 连接/零窗口不恢复——永远等不到 drain，无界豁免会让「暂停的上游连接 +
          // 已缓冲数据」常驻泄漏）；unref 保证优雅停机时不被该定时器拖住进程
          bpDeadline ??= setTimeout(
            () => proxied.destroy(new Error(`背压持续超过 ${BP_MAX_WAIT_MS}ms，视为下游挂死`)),
            BP_MAX_WAIT_MS
          );
          bpDeadline.unref?.();
          res.once('drain', () => {
            // 真实流量恢复：统一收尾后重挂空闲计时器再续读（上游若真挂死仍会被超时兜住）
            clearBackpressure();
            rearmIdleTimer();
            upstreamRes.resume();
          });
        });
        upstreamRes.on('end', () => {
          clearBackpressure();
          res.end();
        });
        // 上游响应流中途出错（next start 崩溃/断开）：只能截断，不追加文本
        upstreamRes.on('error', () => res.destroy());
      }
    );
    // 下游写出错（客户端半途断开触发 EPIPE 等）：断开上游并清掉背压兜底定时器；
    // 挂监听本身就能避免未捕获异常带崩代理进程。必须在收到上游响应之前注册——
    // 等待上游期间、或写 502 时客户端已断开，同样会触发 res 的 error，只在响应
    // 回调里挂监听会留下未覆盖窗口
    res.on('error', () => {
      clearBackpressure();
      proxied.destroy();
    });
    // 上游连接阶段出错（未就绪/已退出）：未回传时给可读的 502；已回传只能截断
    proxied.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`上游不可达 (${upstream.href}): ${err.message}`);
      } else {
        res.destroy();
      }
    });
    // 空闲超时：销毁上游连接（上面的 error 处理负责收尾下游）；
    // 背压期间豁免并重挂计时器——手机弱网收拢 TCP 窗时上游暂停读是正常背压，
    // 不是挂死（重挂保证豁免后仍有下一次超时机会）；下游彻底不读的挂死场景
    // 由回传泵里的 bpDeadline 墙钟兜底销毁
    proxied.on('timeout', () => {
      if (backpressured) {
        rearmIdleTimer();
        return;
      }
      proxied.destroy(new Error(`上游空闲超时 (${UPSTREAM_IDLE_TIMEOUT_MS}ms)`));
    });
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

/* Ctrl+C / 终止信号：优雅关闭监听，但有界退出 */
/* server.close 要等所有连接（含播放中的媒体流）自然结束才回调，可能永不触发；
 * 宽限期后强制断开残余连接（close 回调随之触发），另有终极兜底硬退出。
 * 上游 next start 进程由 dev-https.sh 的 trap 回收，本代理只负责自己有界退出。 */
const SHUTDOWN_GRACE_MS = 3000;
// 终极兜底硬退出的硬上限：宽限期 + 2s 余量（具名常量——与 SHUTDOWN_GRACE_MS 并排
// 的裸数字容易在调宽限期时被遗忘）
const SHUTDOWN_HARD_EXIT_MS = SHUTDOWN_GRACE_MS + 2000;
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // 第二次信号视为「不想再等」：立即退出
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    server.close(() => process.exit(0));
    // 宽限期到：断开仍在占线的连接（媒体流只能截断，客户端会自动重连续播）
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    // 终极兜底：无论如何都在硬上限内退出（closeAllConnections 后仍未退说明
    // 收尾逻辑自身卡死，留一行现场便于诊断）
    setTimeout(() => {
      console.error(`代理停机：宽限期后进程仍未退出，按硬上限 ${SHUTDOWN_HARD_EXIT_MS}ms 强制退出`);
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
  });
}
