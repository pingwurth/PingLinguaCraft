'use client';

/**
 * 离线壳页（PWA 断网时的导航回退）
 *
 * 由 sw.ts 在每次 SW 安装期写入独立缓存 plc-offline-shell（不进预缓存——
 * 其 revision 机制会把「引用构建哈希资源的 HTML」锁死在旧版本，详见 sw.ts
 * 文件头）：断网打开 PWA 或点任何页面导航 → NavigationRoute 网络失败 →
 * 命中本页。无动态数据（可静态预渲染），纸墨风一句话提示 + 重试。
 */

/**
 * 离线壳页组件
 */
export default function OfflinePage() {
  return (
    /* 离线提示容器（垂直居中） */
    <div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-center justify-center px-5 py-10 text-center">
      {/* 离线图标 */}
      <span className="material-symbols-outlined mb-3 text-5xl text-ochre">cloud_off</span>
      {/* 标题 */}
      <h2 className="font-serif text-2xl">离线中</h2>
      {/* 说明文案 */}
      <p className="mt-2 text-sm text-muted-foreground">
        媒体与数据都在局域网服务上，需要联网。请检查手机网络、确认电脑上的服务在运行，然后重试。
      </p>
      {/* 重试按钮（整页刷新，恢复在线后回到目标地址） */}
      <button
        onClick={() => window.location.reload()}
        className="mt-5 rounded-md bg-primary px-6 py-2 text-sm text-primary-foreground"
      >
        重试
      </button>
    </div>
  );
}
