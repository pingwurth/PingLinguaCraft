'use client';

/**
 * Service Worker 注册组件（挂根布局）
 *
 * serwist 的 webpack 侧只负责产出 sw.js；页面侧需显式注册才会安装。
 * 开发模式：跳过注册，并清理同源历史构建遗留的生产 SW——
 * - 注销注册（否则旧预缓存会继续接管 _next/static，dev 加载旧 JS、热更异常）
 * - 注销不会解除当前页面的 controller：若本页正被旧 SW 接管，注销后刷新
 *   一次让 dev 走网络直连；sessionStorage 一次性标记防循环（unregister 在
 *   installing 等状态下会 resolve false，不校验即刷新可能无限循环）
 * - 顺带删掉旧 SW 遗留的缓存（serwist 预缓存 + 壳页缓存；dev 下不会有新
 *   SW 安装/activate，没有别的清理时机，只能一直留在浏览器里）
 */

import { useEffect } from 'react';

/** 防刷新循环的一次性标记键（sessionStorage） */
const SW_DEV_CLEANED_FLAG = 'plc-sw-dev-cleaned';

/** SW 注册组件（无 UI） */
export function SwRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      const wasControlled = Boolean(navigator.serviceWorker.controller);
      void (async () => {
        try {
          const rs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(rs.map((r) => r.unregister()));
          // 清理旧 SW 的缓存（预缓存体积可观，dev 下不会再有清理时机）
          const keys = await caches.keys();
          await Promise.all(
            keys.filter((k) => /^(serwist|plc-)/.test(k)).map((k) => caches.delete(k))
          );
          // controller 已注销但仍接管本页：刷新一次；标记保证至多一次
          if (wasControlled && !sessionStorage.getItem(SW_DEV_CLEANED_FLAG)) {
            sessionStorage.setItem(SW_DEV_CLEANED_FLAG, '1');
            window.location.reload();
          } else if (!wasControlled) {
            sessionStorage.removeItem(SW_DEV_CLEANED_FLAG);
          }
        } catch {
          /* 清理尽力而为，失败不影响 dev 使用 */
        }
      })();
      return;
    }
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
