'use client';

/**
 * 应用外壳（AppShell）
 *
 * 响应式双形态，对应设计稿的两套壳：
 * - 移动端（<md）：固定顶栏（纸墨研习斋标题）+ 5-tab 底部导航（精读/语流/生词/演练/我的）
 * - 桌面端（≥md）：w-64 左侧栏（导航 + 导入按钮）+ 顶栏
 * 顶栏与底部导航均预留安全区 padding（刘海屏/手势条）。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** 底部导航/侧边栏共用的导航项定义 */
const NAV_ITEMS = [
  { href: '/', label: '精读', icon: 'menu_book', match: (p: string) => p === '/' || p.startsWith('/collection') || p.startsWith('/material') },
  { href: '/stream', label: '语流', icon: 'graphic_eq', match: (p: string) => p.startsWith('/stream') },
  { href: '/words', label: '生词', icon: 'edit_note', match: (p: string) => p.startsWith('/words') },
  { href: '/practice', label: '演练', icon: 'sports_esports', match: (p: string) => p.startsWith('/practice') },
  { href: '/settings', label: '我的', icon: 'person', match: (p: string) => p.startsWith('/settings') || p.startsWith('/favorites') },
] as const;

/**
 * 应用外壳组件：包裹所有页面，提供移动/桌面双形态导航
 * @param props.children 页面内容
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    /* 最外层容器：动态视口高度 + 纸底色 */
    <div className="flex min-h-dvh flex-col bg-background md:flex-row">
      {/* ===== 桌面端左侧栏（≥md 显示，仿设计稿 w-64 藏经阁侧栏） ===== */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-card md:flex">
        {/* 品牌区：衬线字体标题 + slogan */}
        <div className="border-b border-border px-6 py-6">
          <h1 className="font-serif text-xl leading-tight">纸墨研习斋</h1>
          <p className="mt-1 text-xs text-ochre">书山万仞吾独取</p>
        </div>
        {/* 导航列表 */}
        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {NAV_ITEMS.map((item) => (
            /* 导航链接：活动态朱砂文字 + 淡染底 */
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                item.match(pathname)
                  ? 'bg-accent font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {/* Material Symbols 图标 */}
              <span className="material-symbols-outlined text-xl">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        {/* 底部导入按钮：朱砂主色 */}
        <div className="border-t border-border p-4">
          <Link
            href="/import"
            className="flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            纳新入卷（导入）
          </Link>
        </div>
      </aside>

      {/* ===== 主内容列：移动端顶栏 + 页面 + 底部导航 ===== */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏（<md 显示）：安全区适配 */}
        <header className="sticky top-0 z-20 border-b bg-background pt-safe md:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            {/* 品牌标题：衬线字体 */}
            <h1 className="font-serif text-lg leading-none">纸墨研习斋</h1>
            {/* 导入入口：朱砂图标按钮 */}
            <Link
              href="/import"
              aria-label="导入新材料"
              className="flex size-9 items-center justify-center rounded-md text-primary"
            >
              <span className="material-symbols-outlined text-2xl">add_circle</span>
            </Link>
          </div>
        </header>

        {/* 页面主体：底部导航高度预留（移动端） */}
        <main className="flex-1 pb-[calc(env(safe-area-inset-bottom)+4rem)] md:pb-0">{children}</main>

        {/* 移动端底部导航（<md 显示）：5-tab，仿设计稿 _1 */}
        <nav className="fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-safe md:hidden">
          <div className="grid grid-cols-5">
            {NAV_ITEMS.map((item) => (
              /* 单个导航项：活动态朱砂，44px 触控目标 */
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                className={`flex h-16 flex-col items-center justify-center gap-0.5 ${
                  item.match(pathname) ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <span className="material-symbols-outlined text-2xl">{item.icon}</span>
                <span className="text-[11px] leading-none">{item.label}</span>
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
