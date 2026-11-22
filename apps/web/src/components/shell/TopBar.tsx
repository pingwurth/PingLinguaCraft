'use client';

/**
 * 桌面端全局顶栏（TopBar）——完全参照设计稿 linguacraft_16 复刻
 *
 * 三段结构（排布与设计稿一致）：
 * - 全局检索框（左，w-96 压印槽）：surface-container-low 冷灰底 + search 图标内嵌，
 *   卷名 / 材料标题即时检索，下拉结果面板支持 ↑↓ 选择、Enter 跳转、Esc 关闭、
 *   点击面板外关闭（检索逻辑与结果渲染复用 features/search，与移动端全屏检索同源）；
 *   ⌘K / Ctrl+K 聚焦检索框（占位符快捷键提示真实可用）
 * - 引擎状态灯（右）：竹青圆点 + 状态文案（/api/engine 健康探测，与设置页共享 ['engine'] 缓存）
 * - 导入文献（右）：container-high 中性按钮 → /import（设计稿顶栏按钮为中性底而非主按钮）
 * - 我的设置入口（右）：深朱印章头像（12px 圆角方印）→ /settings
 *
 * 视觉：bg-surface/80 毛玻璃 + backdrop-blur-xl + 0 1px 8px 4% 极淡投影（设计稿原样，
 * 替代纸墨约定的 1px 书边细线）；色彩一律走 globals.css 的「案头壳稿色板」语义 token。
 * 仅桌面（≥md）渲染；移动端顶栏（含三入口与全屏检索）在 AppShell。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGlobalSearch } from '@/features/search/useGlobalSearch';
import { SearchResultList } from '@/features/search/SearchResultList';
import { api } from '@/lib/api';

/** 引擎健康探测的最小响应形态（完整 EngineInfo 见设置页；顶栏状态灯只关心 healthy） */
interface EngineHealth {
  /** 本地 AI 引擎（127.0.0.1:8765）健康与否 */
  healthy: boolean;
}

/**
 * 桌面端全局顶栏组件：检索 + 引擎状态 + 导入 + 设置入口（仅 ≥md 渲染）
 */
export function TopBar() {
  const router = useRouter();
  /* 检索逻辑单源：防抖输入、请求、命中扁平化（hooks/面板开合见 hook 内注释） */
  const { raw, setRaw, q, open, setOpen, search, hits, reset } = useGlobalSearch();
  /* 键盘选择游标：-1 表示未选中（Enter 落在首条命中） */
  const [active, setActive] = useState(-1);
  /* 检索区容器引用：点击面板外关闭用 */
  const boxRef = useRef<HTMLDivElement>(null);
  /* 检索输入框引用：⌘K 全局快捷键聚焦用 */
  const inputRef = useRef<HTMLInputElement>(null);

  /* 结果集变化时复位键盘游标（悬停/方向键重新选择） */
  useEffect(() => setActive(-1), [hits]);

  /* 点击面板外关闭（pointerdown 而非 blur：面板内链接的 click 先于关闭发生） */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, setOpen]);

  /* ⌘K / Ctrl+K 聚焦检索框并展开面板（全局监听；输入聚焦时浏览器默认无该绑定，不冲突） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  /* 引擎健康探测：与设置页共享 ['engine'] 查询缓存；60s 轻轮询维持状态灯新鲜 */
  const engine = useQuery({
    queryKey: ['engine'],
    queryFn: () => api<EngineHealth>('/api/engine'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const engineOnline = engine.data?.healthy === true;
  const engineText = engine.isPending
    ? '引擎探询中…'
    : engineOnline
      ? '引擎在线 · 本地推理'
      : '引擎休眠 · 离线';

  /** 跳转命中项并复位（键盘 Enter 路径；Link 点击路径走自身导航 + onSelect 善后） */
  const go = (href: string) => {
    reset();
    setOpen(false);
    router.push(href);
  };

  /** Link 点击后的善后：复位检索词并收起面板（导航由 Link 自身完成） */
  const onSelect = () => {
    reset();
    setOpen(false);
  };

  /**
   * 检索框键盘交互：↑↓ 选择 / Enter 跳转 / Esc 先关面板再清词
   * @param e 输入框键盘事件
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      const hit = hits[active] ?? hits[0];
      if (hit) {
        e.preventDefault();
        go(hit.href);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      } else if (raw) {
        reset();
      }
    }
  };

  const showPanel = open && q.length > 0;

  return (
    /* 桌面顶栏：吸顶 + surface/80 毛玻璃 + 设计稿原样极淡投影（替代纸墨 1px 细线） */
    <header className="sticky top-0 z-30 hidden bg-surface/80 shadow-[0_1px_8px_rgba(0,0,0,0.04)] backdrop-blur-xl md:block">
      <div className="flex h-16 items-center justify-between px-10">
        {/* 左段：全局检索槽（w-96 定宽；冷灰压印底 + 图标内嵌，设计稿同款） */}
        <div ref={boxRef} className="relative w-96 shrink-0">
          {/* 压印槽容器：图标 + 透明输入框；聚焦时染深一阶（键盘焦点可见性） */}
          <div className="flex items-center gap-2 rounded-md bg-surface-container-low px-4 py-1 text-on-surface-variant transition-colors focus-within:bg-surface-container">
            {/* 检索图标：内嵌槽内左侧（20px，继承赭褐） */}
            <span aria-hidden className="material-symbols-outlined text-[20px]">
              search
            </span>
            {/* 检索输入框：透明无框（body-sm 13px 角色），占位符带 ⌘K 快捷键提示 */}
            <input
              ref={inputRef}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded={showPanel}
              aria-controls="global-search-listbox"
              aria-activedescendant={active >= 0 ? `global-search-option-${active}` : undefined}
              aria-label="全局检索：材料集卷名与名篇标题"
              placeholder="搜寻典籍与名篇 (⌘K)…"
              autoComplete="off"
              className="min-w-0 flex-1 border-none bg-transparent font-body-sm text-body-sm text-on-surface outline-none placeholder:text-on-surface-variant"
            />
          </div>
          {/* 清空按钮：仅有输入时出现（压印槽右内侧） */}
          {raw ? (
            <button
              type="button"
              aria-label="清空检索词"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          ) : null}
          {/* 结果面板：吸在检索槽正下方（纯白底 + container-high 细边 + 轻投影，配壳稿冷灰系） */}
          {showPanel ? (
            <div
              id="global-search-listbox"
              role="listbox"
              aria-label="检索结果"
              className="absolute inset-x-0 top-full z-50 mt-2 max-h-80 overflow-y-auto rounded-md border border-surface-container-high bg-surface-container-lowest shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
            >
              <SearchResultList
                hits={hits}
                collectionCount={search.data?.collections.length ?? 0}
                loading={search.isFetching && !search.data}
                error={search.isError ? search.error.message : null}
                idPrefix="global-search"
                activeIndex={active}
                onSelect={onSelect}
                onHover={setActive}
              />
            </div>
          ) : null}
        </div>

        {/* 右段三件套：引擎状态灯 + 导入文献 + 印章头像（设计稿 gap-space-lg 排布） */}
        <div className="flex shrink-0 items-center gap-6">
          {/* 引擎状态灯：竹青圆点（离线/探询中灰阶）+ 状态文案 */}
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`size-2 rounded-full ${
                engineOnline ? 'bg-shell-bamboo' : 'bg-surface-container-highest'
              }`}
            />
            <span className="text-label-sm text-on-surface-variant">{engineText}</span>
          </div>
          {/* 导入文献：中性 container-high 按钮（设计稿顶栏按钮形态）→ 导入向导 */}
          <Link
            href="/import"
            aria-label="导入新材料"
            className="flex items-center gap-1 rounded-md bg-surface-container-high px-4 py-1 text-on-surface transition-colors hover:bg-surface-container-highest"
          >
            <span className="material-symbols-outlined text-[18px]">library_add</span>
            <span className="text-label-sm">导入文献</span>
          </Link>
          {/* 我的设置入口：深朱印章头像（设计稿 12px 圆角方印）→ 设置页 */}
          <Link
            href="/settings"
            aria-label="我的 · 设置"
            className="flex size-8 items-center justify-center rounded-xl bg-shell-seal"
          >
            <span className="material-symbols-outlined text-[18px] text-white">person</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
