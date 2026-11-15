'use client';

/**
 * Service Worker 注册组件（挂根布局）
 *
 * serwist 的 webpack 侧只负责产出 sw.js；页面侧需显式注册才会安装。
 * 开发模式跳过（避免拾取上一次构建的陈旧产物干扰 next dev）。
 */

import { useEffect } from 'react';

/** SW 注册组件（无 UI） */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
