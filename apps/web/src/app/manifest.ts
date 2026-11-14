/**
 * PWA 清单（manifest.webmanifest）
 *
 * 手机浏览器「添加到主屏幕」后以独立窗口运行，接近原生体验。
 * 图标：SVG（任意尺寸）+ 192/512 PNG 栅格（Chrome 安装条件）+
 * maskable 变体（Android 自适应图标蒙版裁切安全区，全出血底 + 80% 内容）。
 * 不锁定 orientation：视频精听横屏是主用例之一，旋转交由系统/页面自行处理。
 * 印章图标目前为占位，正式图标在打磨阶段替换（同步替换 public/icon* 文件）。
 */
import type { MetadataRoute } from 'next';

/**
 * 生成 PWA manifest 对象
 * @returns Next.js 约定的 manifest 路由数据
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PingLinguaCraft · 纸墨研习斋',
    short_name: '纸墨研习',
    description: '书山万仞吾独取，不向旁人问径蹊 —— 媒体驱动的英文精听学习工具',
    /* 独立窗口；不锁定方向（横屏看视频是主用例之一） */
    display: 'standalone',
    start_url: '/',
    background_color: '#fbf9f5',
    theme_color: '#fbf9f5',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
