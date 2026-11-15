'use client';

/**
 * Service Worker 注册组件（挂根布局）
 *
 * serwist 的 webpack 侧只负责产出 sw.js；页面侧需显式注册才会安装。
 * 开发模式：跳过注册，并注销同源历史构建遗留的生产 SW——否则旧预缓存
 * 会继续接管 _next/static，dev 加载旧 JS、热更异常（serwist 官方推荐做法）。
 */

import { useEffect } from 'react';

/** SW 注册组件（无 UI） */
export function SwRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      // dev：清掉上次 next start 遗留的 SW（注销后由网络直连接管）
      void navigator.serviceWorker
        .getRegistrations()
        .then((rs) => rs.forEach((r) => void r.unregister()))
        .catch(() => undefined);
      return;
    }
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
