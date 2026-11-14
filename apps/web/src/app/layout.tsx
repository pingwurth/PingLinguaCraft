/**
 * 根布局：注入字体、全局元数据、视口配置与应用外壳
 *
 * - 字体：Newsreader（文学衬线，标题/引文）+ Inter（界面功能文本），next/font 本地化加载；
 *   Material Symbols Outlined（图标 ligature 字体）自托管于 public/fonts，
 *   由 globals.css 的 @font-face 引入（next/font/google 不收录该字体，且外链 Google Fonts 不可靠）
 * - 视口：viewport-fit=cover 适配刘海屏；主题色与 PWA manifest 呼应
 * - 外壳：AppShell 组件按断点切换移动底部导航 / 桌面侧边栏（见 components/shell）
 */
import type { Metadata, Viewport } from 'next';
import { Inter, Newsreader } from 'next/font/google';
import { preload } from 'react-dom';
import './globals.css';
import { AppShell } from '@/components/shell/AppShell';
import { Providers } from './providers';

/** Inter：界面功能字体（导航、控件、输入、数据标签） */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

/** Newsreader：文学衬线字体（标题、双语文学摘录、成语注释、引文） */
const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
});

/** 站点元数据（PWA 安装时显示的应用名） */
export const metadata: Metadata = {
  title: {
    default: 'PingLinguaCraft · 纸墨研习斋',
    template: '%s · PingLinguaCraft',
  },
  description: '书山万仞吾独取，不向旁人问径蹊 —— 媒体驱动的英文精听学习工具',
  applicationName: 'PingLinguaCraft',
  manifest: '/manifest.webmanifest',
};

/** 视口配置：cover 铺满刘海屏；不禁用缩放（WCAG 1.4.4——放大字幕是刚需，
 *  播放页防误触由播放器控件层自行处理，不做全局禁缩放） */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#fbf9f5',
};

/**
 * 根布局组件
 * @param props.children 页面内容
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  // 预加载图标字体：@font-face 用 font-display:block（阻塞期图标不可见，最长约 3s），
  // preload 让 woff2 与首屏资源并行下载，把空窗压到最短（渲染期调用，SSR/CSR 均生效）。
  // 注意：路径与 globals.css @font-face 的 src 保持一致——改字体文件位置时两处同步改
  preload('/fonts/material-symbols-outlined.woff2', {
    as: 'font',
    type: 'font/woff2',
    crossOrigin: 'anonymous', // 字体获取总是 CORS 模式，preload 须与实际请求一致才能命中
  });
  return (
    /* html 元素：挂载字体 CSS 变量（图标字体见 globals.css 的 @font-face） */
    <html lang="zh-CN" className={`${inter.variable} ${newsreader.variable}`}>
      {/* body 元素：承载应用外壳与页面内容（Providers 提供 react-query 上下文） */}
      <body className="antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
