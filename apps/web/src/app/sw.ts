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

// 预缓存 = 构建清单（静态资源）；runtimeCaching 显式留空
const sw = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [],
});

// 壳页入专用缓存：每次安装先清后取（安装仅在部署后 sw.js 变化时发生，
// 取到的 /offline HTML 与当次构建的资源哈希一致）。取失败不阻断 SW 安装
// （仅本次无壳可用，下次部署自然补上）
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(OFFLINE_CACHE);
        await cache.delete(OFFLINE_URL);
        await cache.add(OFFLINE_URL);
      } catch {
        /* 安装瞬间服务不可达：跳过，不阻断 SW 安装 */
      }
    })()
  );
});

/**
 * 导航处理器：preload → 网络优先（页面实时），双双失败（离线）回落壳页
 * 缓存——这正是「离线可开壳」的承担点
 * @param options 路由回调参数（取 FetchEvent 以读 preloadResponse）
 */
async function navigationHandler({ event }: RouteHandlerCallbackOptions): Promise<Response> {
  // 路由回调的 event 声明为 ExtendableEvent，导航路由实际必为 FetchEvent
  const fetchEvent = event as FetchEvent;
  try {
    // 注意：导航预载的 Promise 在断网时会 reject——必须一并包进 try，
    // 否则壳页回落永远走不到
    const preload = await fetchEvent.preloadResponse;
    if (preload) return preload;
    return await fetch(fetchEvent.request);
  } catch {
    const cache = await caches.open(OFFLINE_CACHE);
    const shell = await cache.match(OFFLINE_URL);
    if (shell) return shell;
    throw new Error('offline: shell not cached');
  }
}

// 页面导航路由（denylist 保 API 直连；详见文件头注释）
sw.registerRoute(new NavigationRoute(navigationHandler, { denylist: [/^\/api\//] }));

sw.addEventListeners();
