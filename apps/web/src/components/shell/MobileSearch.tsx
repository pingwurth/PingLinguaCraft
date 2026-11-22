'use client';

/**
 * 移动端全屏检索浮层（MobileSearch）
 *
 * 移动顶栏放大镜入口的全屏检索面板（<md；桌面检索在 TopBar 下拉）：
 * 返回键 + 检索输入框 + 共享结果列表（features/search/SearchResultList）。
 * 打开时聚焦输入框（弹出软键盘）并锁定背景滚动；命中跳转后复位并关闭。
 * 视觉与壳层同源（案头壳稿冷灰系）：surface 底、检索槽同桌面 TopBar（container-low 压印底）。
 */

import { useEffect, useRef } from 'react';
import { useGlobalSearch } from '@/features/search/useGlobalSearch';
import { SearchResultList } from '@/features/search/SearchResultList';

/** 全屏检索浮层 props */
interface MobileSearchProps {
  /** 开合（由移动顶栏放大镜按钮驱动） */
  open: boolean;
  /** 关闭回调（返回键 / 命中跳转后由 AppShell 收起） */
  onClose: () => void;
}

/**
 * 移动端全屏检索浮层组件
 * @param props 见 MobileSearchProps
 */
export function MobileSearch({ open, onClose }: MobileSearchProps) {
  /* 检索逻辑与桌面同源（关闭再开保留上次检索词，便于误关后回到结果） */
  const { raw, setRaw, q, search, hits, reset } = useGlobalSearch();
  const inputRef = useRef<HTMLInputElement>(null);

  /* 打开时聚焦输入框（弹软键盘）并锁定背景滚动；关闭时恢复 */
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  /** 选中善后：复位检索词、收起浮层（导航由结果行的 Link 自身完成） */
  const onSelect = () => {
    reset();
    onClose();
  };

  return (
    /* 全屏浮层：案头 surface 底 + 安全区适配（刘海/手势条） */
    <div
      role="dialog"
      aria-modal="true"
      aria-label="全局检索"
      className="fixed inset-0 z-50 flex flex-col bg-surface pb-safe pt-safe"
    >
      {/* 浮层顶栏：返回键 + 检索输入框（极淡投影替代边线，与壳层顶栏同语言） */}
      <div className="flex items-center gap-1 px-2 py-2 shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
        {/* 返回键：关闭浮层并复位检索词 */}
        <button
          type="button"
          aria-label="关闭检索"
          onClick={() => {
            reset();
            onClose();
          }}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
        >
          <span className="material-symbols-outlined text-[22px]">arrow_back</span>
        </button>
        {/* 检索槽：与桌面 TopBar 同款压印形态（container-low 底 + 图标内嵌 + 透明输入框） */}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-surface-container-low px-4 py-2 text-on-surface-variant transition-colors focus-within:bg-surface-container">
          <span aria-hidden className="material-symbols-outlined text-[20px]">
            search
          </span>
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              /* Esc 关闭（外接键盘场景；软键盘走返回键） */
              if (e.key === 'Escape') {
                reset();
                onClose();
              }
            }}
            enterKeyHint="search"
            aria-label="检索材料集卷名与名篇标题"
            placeholder="搜寻典籍与名篇 (⌘K)…"
            autoComplete="off"
            className="min-w-0 flex-1 border-none bg-transparent font-body-md text-body-md text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </div>
      </div>

      {/* 结果区：有词才检索（三态在共享列表组件内） */}
      {q ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <SearchResultList
            hits={hits}
            collectionCount={search.data?.collections.length ?? 0}
            loading={search.isFetching && !search.data}
            error={search.isError ? search.error.message : null}
            idPrefix="mobile-search"
            onSelect={onSelect}
          />
        </div>
      ) : (
        /* 初始提示态：引导输入 */
        <p className="px-6 py-10 text-center text-body-sm text-on-surface-variant">
          输入关键词，检索材料集与名篇标题
        </p>
      )}
    </div>
  );
}
