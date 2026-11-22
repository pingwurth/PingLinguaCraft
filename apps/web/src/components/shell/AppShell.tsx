'use client';

/**
 * 应用外壳（AppShell）
 *
 * 响应式双形态，UI 与 PC 端完全同构（同一导航条目、同一案头壳稿视觉）：
 * - 移动端（<md）：固定顶栏（品牌区 + 检索 / 导入 / 我的三入口）+ 5-tab 底部导航
 *   （藏经阁库/语流听席/文墨词札/演练闯关/静思复习——与桌面侧栏五条目一一对应；
 *   「我的」由顶栏头像承担，与桌面「设置入口在顶栏头像」一致）；
 *   检索入口打开全屏检索浮层（MobileSearch）
 * - 桌面端（≥md）：完全参照设计稿 linguacraft_16 复刻——
 *   w-64 左侧栏（ink_pen 印章品牌区 + 已研句段 chip + 「典藏阁/研习录」分组导航 + 底部研墨造诣卡），
 *   surface-container 冷灰容器族着色，0 1px 8px 4% 极淡投影（设计稿原样，替代纸墨 1px 细线约定），
 *   底卡/chip 的数据槽位接真实统计（/api/home，与首页共享 ['home'] 查询缓存）
 *   + 全局顶栏（检索 / 引擎状态 / 导入 / 印章头像，见 TopBar）
 * 品牌区（两种形态同款：ink_pen 深朱印章 + 纸墨研习 · 案头）均为回首页入口
 * （Link → /，案头今研视图；藏经阁在侧栏/底栏「藏经阁库」条目 → /library）。
 * 顶栏与底部导航均预留安全区 padding（刘海屏/手势条）。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TopBar } from '@/components/shell/TopBar';
import { MobileSearch } from '@/components/shell/MobileSearch';
import { api } from '@/lib/api';
import { HOME_QUERY_KEY } from '@/features/home/query-keys';
import type { HomeData } from '@/features/home/types';

/**
 * 壳层导航条目单源：移动端底部 5-tab 与桌面端侧栏分组共用同一份定义
 * （同目的地 / 同图标 / 同标签；group 字段供桌面端「典藏阁 / 研习录」分组）。
 * 数组顺序即移动端 tab 排序；桌面端分组内按数组先后渲染。
 * 「我的」（/settings、/favorites）不入导航：两形态均由顶栏/头部位像承担（设置页内链收藏）。
 * 首页（/，案头今研）不入导航：入口为左上角品牌区（Logo）。
 */
/** 桌面侧栏分组标签（条目 group 以此联合类型约束——漏配/写错值会编译报错，
 *  而非条目在侧栏静默消失） */
const SHELL_NAV_GROUP_LABELS = ['典藏阁', '研习录'] as const;
type ShellNavGroup = (typeof SHELL_NAV_GROUP_LABELS)[number];

/** 壳层导航条目形态 */
interface ShellNavItem {
  href: string;
  label: string;
  icon: string;
  group: ShellNavGroup;
  match: (p: string) => boolean;
}

/** 研习辅助条目形态（不带 group：不进移动 5-tab，仅桌面侧栏末组） */
interface ShellAuxItem {
  href: string;
  label: string;
  icon: string;
  match: (p: string) => boolean;
}

const SHELL_NAV_ITEMS: readonly ShellNavItem[] = [
  {
    href: '/library',
    label: '藏经阁库',
    icon: 'local_library',
    group: '典藏阁',
    match: (p: string) => p === '/library' || p.startsWith('/collection') || p.startsWith('/material'),
  },
  {
    href: '/stream',
    label: '语流听席',
    icon: 'graphic_eq',
    group: '研习录',
    match: (p: string) => p.startsWith('/stream'),
  },
  {
    href: '/words',
    label: '文墨词札',
    icon: 'history_edu',
    group: '典藏阁',
    match: (p: string) => p.startsWith('/words'),
  },
  {
    href: '/practice',
    label: '演练闯关',
    icon: 'sports_esports',
    group: '研习录',
    match: (p: string) => p.startsWith('/practice'),
  },
  {
    href: '/review',
    label: '静思复习',
    icon: 'self_improvement',
    group: '研习录',
    match: (p: string) => p.startsWith('/review'),
  },
];

/** 桌面侧栏「研习辅助」组（仿设计稿 _7 侧栏 Manual：词汇深研手册入口）。
 *  不入 SHELL_NAV_ITEMS——移动底部导航固定 5-tab，手册在移动端由词藏页/复习页链入。 */
const SHELL_AUX_ITEMS: readonly ShellAuxItem[] = [
  {
    href: '/manual',
    label: '研习手册',
    icon: 'menu_book',
    match: (p: string) => p.startsWith('/manual'),
  },
];

/** 桌面侧栏分组视图：按 group 字段聚合（典藏阁：馆藏资产；研习录：研习活动），
 *  分组标签取自 SHELL_NAV_GROUP_LABELS 单源，仿 linguacraft_16；末尾追加研习辅助组 */
const DESKTOP_NAV_GROUPS: ReadonlyArray<{ label: string; items: readonly (ShellNavItem | ShellAuxItem)[] }> = [
  ...SHELL_NAV_GROUP_LABELS.map((label) => ({
    label,
    items: SHELL_NAV_ITEMS.filter((item) => item.group === label),
  })),
  { label: '研习辅助', items: SHELL_AUX_ITEMS },
];

/**
 * 应用外壳组件：包裹所有页面，提供移动/桌面双形态导航
 * @param props.children 页面内容
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  /* 移动端全屏检索浮层开合（顶栏放大镜入口） */
  const [searchOpen, setSearchOpen] = useState(false);

  /* 壳层统计：与首页共享 ['home'] 查询缓存（首页零额外请求；其余页面补一次本地聚合查询）。
   * staleTime 60s：壳层常驻每个路由都挂着，不设 stale 的话窗口每次重新聚焦都
   * 重取一次重聚合接口（集卷聚合 + 全表位图 + 三条查询），移动端也照付 */
  const home = useQuery({
    queryKey: HOME_QUERY_KEY,
    queryFn: () => api<HomeData>('/api/home'),
    staleTime: 60_000,
  });
  /* 全馆总句数（各集卷句数合计）与已研句数 → 全馆研读进度百分比（研墨造诣卡） */
  const totalSentences = home.data?.collections.reduce((a, c) => a + c.sentenceCount, 0) ?? 0;
  const studiedCount = home.data?.stats.studiedSentenceCount ?? 0;
  const progressPct =
    totalSentences > 0 ? Math.min(100, Math.round((studiedCount / totalSentences) * 100)) : 0;

  return (
    /* 最外层容器：动态视口高度 + 纸底色 */
    <div className="flex min-h-dvh flex-col bg-background md:flex-row">
      {/* ===== 桌面端左侧栏（≥md；linguacraft_16 同款：container-low 冷灰底 + 极淡投影，无边线） ===== */}
      <aside className="sticky top-0 z-30 hidden h-dvh w-64 shrink-0 flex-col bg-surface-container-low py-6 shadow-shell md:flex">
        {/* 上半区：品牌 + chip + 导航（设计稿 gap-space-lg 三段纵排）；min-h-0 让
            导航区在短视口（缩放 150%/大字号）下自身滚动，底部条目不致被裁掉 */}
        <div className="flex min-h-0 flex-1 flex-col gap-6">
          {/* 品牌区（ShellBrand 单源）：点击回首页（案头今研） */}
          <div className="px-6">
            <ShellBrand />
          </div>
          {/* 已研句段 chip（设计稿「今日砚墨」槽位；值取真实统计 studiedSentenceCount） */}
          <div className="px-4">
            <div className="flex items-center justify-between rounded-md bg-surface-container p-2">
              <span className="flex items-center gap-1">
                {/* 竹青 timer 图标 + 赭褐标签 */}
                <span className="material-symbols-outlined text-[18px] text-shell-bamboo">
                  timer
                </span>
                <span className="text-label-sm text-on-surface-variant">已研句段</span>
              </span>
              {/* 右值：竹青半粗（加载中显示破折号占位） */}
              <span className="text-label-sm font-semibold text-shell-bamboo">
                {home.data ? `${studiedCount} 句` : '—'}
              </span>
            </div>
          </div>
          {/* 分组导航：组标签（典藏阁/研习录）+ 条目；活动态 = container-highest 染底 + 浓墨半粗 */}
          <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4">
            {DESKTOP_NAV_GROUPS.map((group, gi) => (
              <Fragment key={group.label}>
                {/* 组标签：第二组起加 mt-2（设计稿 mt-space-sm 与导航 gap 叠加出的呼吸感） */}
                <div
                  className={`px-2 py-1 text-label-sm text-on-surface-variant ${gi > 0 ? 'mt-2' : ''}`}
                >
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={item.match(pathname) ? 'page' : undefined}
                    className={`flex items-center gap-2 rounded-md px-4 py-2 transition-colors ${
                      item.match(pathname)
                        ? 'bg-surface-container-highest font-semibold text-on-surface'
                        : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                    }`}
                  >
                    {/* Material Symbols 图标（20px；活动态随 font-semibold 加粗笔画，同设计稿） */}
                    <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
                    <span className="text-body-md">{item.label}</span>
                  </Link>
                ))}
              </Fragment>
            ))}
          </nav>
        </div>
        {/* 研墨造诣卡（设计稿底部卡槽位）：全馆研读进度（深朱进度条 + 百分比），钉在侧栏底部 */}
        <div className="px-4">
          <div className="flex flex-col gap-1 rounded-md bg-surface-container-high p-4">
            <div className="flex items-center justify-between">
              <span className="text-label-sm text-on-surface-variant">研墨造诣</span>
              {/* 右值：深朱加粗（集卷数；加载中显示破折号占位） */}
              <span className="text-label-sm font-bold text-shell-seal">
                {home.data ? `${home.data.stats.collectionCount} 卷` : '—'}
              </span>
            </div>
            {/* 进度条：纯白槽底 + 深朱填充（宽度=全馆已研句占比） */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-lowest">
              <div className="h-full bg-shell-seal" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="text-right text-label-sm text-on-surface-variant">
              已润 {progressPct}% 墨卷
            </span>
          </div>
        </div>
      </aside>

      {/* ===== 主内容列：移动端顶栏 + 页面 + 底部导航 ===== */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 桌面端全局顶栏（≥md 显示）：检索 / 引擎状态 / 导入 / 设置入口（组件内部隐藏移动端） */}
        <TopBar />

        {/* 移动端顶栏（<md 显示）：与桌面 TopBar 同款视觉（毛玻璃 + 极淡投影），另留安全区 */}
        <header className="sticky top-0 z-30 bg-surface/80 pt-safe shadow-shell backdrop-blur-xl md:hidden">
          <div className="flex h-16 items-center justify-between px-4">
            {/* 品牌区（ShellBrand 单源）：与桌面侧栏同款，点击回首页（案头今研） */}
            <ShellBrand />
            {/* 右侧三入口：检索 / 导入 / 我的（44px 触控目标；检索打开全屏浮层） */}
            <div className="flex items-center gap-1">
              {/* 检索入口：放大镜，打开全屏检索浮层 */}
              <button
                type="button"
                aria-label="全局检索"
                onClick={() => setSearchOpen(true)}
                className="flex size-11 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[22px]">search</span>
              </button>
              {/* 导入入口：图标按钮 → 导入向导 */}
              <Link
                href="/import"
                aria-label="导入新材料"
                className="flex size-11 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[22px]">add_circle</span>
              </Link>
              {/* 我的入口：深朱印章头像（与桌面顶栏头像同款）→ 设置页 */}
              <Link href="/settings" aria-label="我的 · 设置" className="flex size-11 items-center justify-center">
                <span className="flex size-8 items-center justify-center rounded-xl bg-shell-seal">
                  <span className="material-symbols-outlined text-[18px] text-on-shell-seal">person</span>
                </span>
              </Link>
            </div>
          </div>
        </header>

        {/* 页面主体：底部导航高度预留（移动端） */}
        <main className="flex-1 pb-[calc(env(safe-area-inset-bottom)+4rem)] md:pb-0">{children}</main>

        {/* 移动端底部导航（<md 显示）：container-low 冷灰底 + 顶部极淡投影；
            5-tab 与桌面侧栏五条目同构（同 label/icon/目的地），活动态同桌面（container-highest 染底半粗） */}
        <nav className="fixed inset-x-0 bottom-0 z-30 bg-surface-container-low pb-safe shadow-shell-up md:hidden">
          <div className="grid grid-cols-5">
            {SHELL_NAV_ITEMS.map((item) => (
              /* 单个 tab：活动态染底药丸 + 浓墨半粗，44px+ 触控目标。
                 字重挂在标签 span 上——角色 token 的 font-weight 声明在子元素
                 自身，父级继承压不过它，挂 Link 上是无效样式 */
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                aria-current={item.match(pathname) ? 'page' : undefined}
                className={`mx-1 my-2 flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors ${
                  item.match(pathname)
                    ? 'bg-surface-container-highest text-on-surface'
                    : 'text-on-surface-variant'
                }`}
              >
                <span className="material-symbols-outlined text-[22px]">{item.icon}</span>
                <span className={`text-label-sm ${item.match(pathname) ? 'font-semibold' : 'font-medium'}`}>
                  {item.label}
                </span>
              </Link>
            ))}
          </div>
        </nav>

        {/* 移动端全屏检索浮层（顶栏放大镜驱动；桌面端无此层） */}
        <MobileSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </div>
  );
}

/**
 * 品牌区组件：ink_pen 深朱印章方 + 双行标题（衬线主标 + 赭褐副标），
 * 点击回首页（案头今研）。桌面侧栏与移动顶栏两处同款单源——文案/字阶
 * 调整只改这一处。
 */
function ShellBrand() {
  return (
    <Link
      href="/"
      aria-label="回到首页"
      className="flex items-center gap-2 rounded-md transition-opacity hover:opacity-80"
    >
      {/* 印章方块：深朱底 + 白色 ink_pen 图标（设计稿 8x8 rounded-lg 同款） */}
      <span className="flex size-8 shrink-0 select-none items-center justify-center rounded-md bg-shell-seal">
        <span className="material-symbols-outlined text-[20px] text-on-shell-seal">ink_pen</span>
      </span>
      {/* 双行标题：衬线主标（headline-sm 角色）+ 赭褐小字副标（label-sm 角色） */}
      <span className="flex flex-col">
        <span className="font-serif text-headline-sm tracking-tight text-on-surface">
          LinguaCraft
        </span>
        <span className="text-label-sm text-on-surface-variant">纸墨研习 · 案头</span>
      </span>
    </Link>
  );
}
