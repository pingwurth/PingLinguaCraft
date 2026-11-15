/// <reference lib="webworker" />

/**
 * Service Worker（serwist）：PWA 离线壳
 *
 * 策略（从构造上保证 API/媒体不被接管，不做脆弱的规则探测）：
 * - 不使用 defaultCache 运行时规则集（其 apis 预设会缓存 /api/*，
 *   媒体 Range 流也会被拆响应污染——均与自托管实时性冲突）
 * - 静态资源与页面导航由预缓存清单 + Serwist 内建的 precache 导航回退承担：
 *   离线可开壳，API 请求未命中任何规则 → 自然直连网络，离线时明确失败
 * - 开发模式由 @serwist/next 自动禁用（不干扰 next dev 热更）
 */

import { Serwist } from 'serwist';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// 预缓存 + 导航回退（offline fallback 到壳页）；runtimeCaching 显式留空
const sw = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [],
});

sw.addEventListeners();
