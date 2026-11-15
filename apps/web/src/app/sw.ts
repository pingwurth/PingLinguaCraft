/// <reference lib="webworker" />

/**
 * Service Worker（serwist）：PWA 离线壳
 *
 * 策略（从构造上保证 API/媒体不被接管，不做脆弱的规则探测）：
 * - 不使用 defaultCache 运行时规则集（其 apis 预设会缓存 /api/*，
 *   媒体 Range 流也会被拆响应污染——均与自托管实时性冲突）
 * - 静态资源（/_next/static、字体、图标）由预缓存清单承担：@serwist/next
 *   构建期注入
 * - 页面导航：NavigationRoute——在线走网络（优先 navigation preload，
 *   页面是 DB 驱动的实时内容，不做页面缓存），断网回落 /offline 壳页；
 *   /api/* 在 denylist（本来也不是导航请求，双保险）
 * - 离线壳页放独立缓存（不进预缓存）：预缓存的 revision 机制对「引用构建
 *   哈希资源的 HTML」会锁死旧版本（壳页 HTML 引用的 chunks 随每次部署变哈希，
 *   固定 revision 永不重取 → 部署后壳页指向死链）；改为每次 SW 安装（即每次
 *   部署后 sw.js 字节变化触发）重取一次，壳页与其资源哈希天然同源
 * - API/媒体请求不注册任何规则 → 直连网络，离线时明确失败
 * - 开发模式由 @serwist/next 自动禁用（不干扰 next dev 热更）；
 *   SwRegister 在 dev 下还会注销历史遗留的生产 SW
 */

import { Serwist, NavigationRoute } from 'serwist';
import type { PrecacheEntry, RouteHandlerCallbackOptions, SerwistGlobalConfig } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/** 离线壳页地址（app/offline 静态页） */
const OFFLINE_URL = '/offline';
/** 壳页专用缓存名（独立于 serwist 预缓存，见文件头说明） */
const OFFLINE_CACHE = 'plc-offline-shell';
/** 导航网络路径的超时（毫秒）：目标场景正是「局域网服务没起来」——TCP 挂起
 *  而非快速拒绝时，不能让用户对着白屏等几十秒才见到壳页 */
const NAV_TIMEOUT_MS = 8_000;

// 预缓存 = 构建清单（静态资源）；runtimeCaching 显式留空
const sw = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [],
});

// 壳页入专用缓存：每次安装（即每次部署后 sw.js 字节变化触发）取一次当次
// 构建的 /offline HTML 覆盖旧条目。先取成功（cache:'reload' 绕开 HTTP 缓存
// 防取到引用旧 chunk 哈希的陈旧 HTML，且断言 2xx）再 put 覆盖——绝不先删后取：
// 缓存跨 SW 版本共享，先删会让仍在接管的旧 SW 立刻失去壳页。取失败不阻断
// SW 安装（沿用旧壳，下次部署自然补上）
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        // 取壳同样带超时：安装期 TCP 挂起会拖住整个 install（skipWaiting
        // 也激活不了），旧壳/旧逻辑一直生效
        const shell = await fetch(new Request(OFFLINE_URL, { cache: 'reload' }), {
          signal: AbortSignal.timeout(NAV_TIMEOUT_MS),
        });
        if (!shell.ok) throw new Error(`offline shell: HTTP ${shell.status}`);
        const cache = await caches.open(OFFLINE_CACHE);
        await cache.put(OFFLINE_URL, shell);
      } catch {
        /* 安装瞬间服务不可达：保留旧壳，不阻断 SW 安装 */
      }
    })()
  );
});

/**
 * 导航处理器：preload → 网络优先（页面实时；两条路径都带超时——局域网
 * 服务挂起时 TCP 不回包，白屏等几十秒不可接受），双双失败/超时（离线）
 * 回落壳页缓存——这正是「离线可开壳」的承担点
 * @param options 路由回调参数（取 FetchEvent 以读 preloadResponse）
 */
async function navigationHandler({ event }: RouteHandlerCallbackOptions): Promise<Response> {
  // 路由回调的 event 声明为 ExtendableEvent，导航路由实际必为 FetchEvent
  const fetchEvent = event as FetchEvent;
  try {
    // 注意：导航预载的 Promise 在断网时会 reject——必须一并包进 try，
    // 否则壳页回落永远走不到
    const preload = await withTimeout(fetchEvent.preloadResponse, NAV_TIMEOUT_MS);
    if (preload) return preload;
    // 超时只覆盖「等到响应头」：拿到响应后立即清定时器——AbortSignal.timeout
    // 在响应后依然 armed，长流式页面（Next 动态页流式 SSR）会被中途 abort
    // 成半截页面
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NAV_TIMEOUT_MS);
    try {
      return await fetch(fetchEvent.request, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 缓存访问本身也可能抛（配额/隐私模式/缓存损坏）——单独包一层，
    // 失败则落到内联兜底页，绝不让导航以浏览器原生错误页收场
    try {
      const cache = await caches.open(OFFLINE_CACHE);
      const shell = await cache.match(OFFLINE_URL);
      if (shell) return shell;
    } catch {
      /* 缓存不可用：直接走内联兜底页 */
    }
    // 壳页也缺失（首装取壳失败等罕见兜底）：最小内联提示页，
    // 好过浏览器原生「无法访问此网站」
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>离线中</title><p style="font:14px/1.8 system-ui;padding:24px">离线中，请检查网络后重试。</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/**
 * 给 Promise 套墙钟超时（超时即 reject；超时器短暂存活可忽略）
 * @param p 目标 Promise（可能为 undefined——preloadResponse 可空）
 * @param ms 超时毫秒
 */
function withTimeout<T>(p: Promise<T | undefined> | undefined, ms: number): Promise<T | undefined> {
  return Promise.race([
    p ?? Promise.resolve(undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('navigation timeout')), ms)),
  ]);
}

// 页面导航路由（denylist 保 API 直连；详见文件头注释）
sw.registerRoute(new NavigationRoute(navigationHandler, { denylist: [/^\/api\//] }));

sw.addEventListeners();
