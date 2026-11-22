'use client';

/**
 * 移动端全屏检索浮层（MobileSearch）
 *
 * 移动顶栏放大镜入口的全屏检索面板（<md；桌面检索在 TopBar 下拉）：
 * 返回键 + 检索输入框 + 共享结果列表（features/search/SearchResultList）。
 * 打开时聚焦输入框（弹出软键盘）、锁定背景滚动并记录原焦点（关闭还原）；
 * 关闭保留检索词（误关重开回到结果），命中跳转后才复位清词。
 * 视觉与壳层同源（案头壳稿冷灰系）：surface 底、检索槽同桌面 TopBar（container-low 压印底）。
 */

import { useEffect, useRef } from 'react';
import { SEARCH_PLACEHOLDER, useGlobalSearch } from '@/features/search/useGlobalSearch';
import { SearchResultList } from '@/features/search/SearchResultList';
import { FOCUSABLE_SELECTOR } from '@/lib/focus';

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
  /* 检索逻辑与桌面同源（关闭保留检索词：复位只在命中跳转后发生） */
  const { raw, setRaw, search, hits, reset, loading } = useGlobalSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  /* 浮层容器引用：Tab 焦点陷阱用 */
  const overlayRef = useRef<HTMLDivElement>(null);
  /* 打开前的焦点元素：关闭时还原（键盘用户不丢位置） */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /* 最新 onClose 经 ref 入 document 监听闭包（防扩大 effect 依赖）；提交期
     同步——渲染期直接赋 ref 在并发渲染下会把未提交的值留在 ref 里 */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /* 打开时聚焦输入框（弹软键盘）、锁定背景滚动、记录原焦点并约束 Tab 在
     浮层内环绕；关闭时恢复滚动与焦点 */
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    /* effect 局部快照：cleanup 时 ref.current 可能已换指（晚于卸载变更） */
    const overlay = overlayRef.current;
    const onKey = (e: KeyboardEvent) => {
      /* Esc 关闭（焦点在返回键/结果行时输入框 onKeyDown 收不到，须在
         document 层接管；onClose 经 ref 入闭包防依赖扩大重跑 effect） */
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      /* Tab 焦点陷阱：浮层 aria-modal，背景须不可达。监听挂 document（冒泡
         到 overlay 的方案在焦点落到 body——点了浮层内非可聚焦区域——时收不到
         事件，陷阱会失效） */
      if (e.key !== 'Tab' || !overlay) return;
      const focusables = overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const outside = !overlay.contains(document.activeElement);
      /* 焦点已逃出浮层：无条件拉回首元素（shift 则末元素） */
      if (outside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  /** 选中善后：复位检索词、收起浮层（导航由结果行的 Link 自身完成） */
  const onSelect = () => {
    reset();
    onClose();
  };

  /* 空态提示由未防抖的输入驱动（请求侧仍由 q 门控）：若用 q 切换，首字符
     敲下到防抖落定之间的 250ms 会残留「输入关键词」提示，与实际输入错位 */
  const hasInput = raw.trim().length > 0;

  return (
    /* 全屏浮层：案头 surface 底 + 安全区适配（刘海/手势条） */
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="全局检索"
      className="fixed inset-0 z-50 flex flex-col bg-surface pb-safe pt-safe"
    >
      {/* 浮层顶栏：返回键 + 检索输入框（极淡投影替代边线，与壳层顶栏同语言） */}
      <div className="flex items-center gap-1 px-2 py-2 shadow-shell">
        {/* 返回键：关闭浮层（保留检索词，误关重开可回到结果） */}
        <button
          type="button"
          aria-label="关闭检索"
          onClick={onClose}
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
            enterKeyHint="search"
            role="combobox"
            aria-expanded={hasInput}
            aria-controls={hasInput ? 'mobile-search-listbox' : undefined}
            aria-label="检索材料集卷名与名篇标题"
            placeholder={SEARCH_PLACEHOLDER.mobile}
            autoComplete="off"
            className="min-w-0 flex-1 border-none bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </div>
      </div>

      {/* 结果区：有输入即出列表容器（listbox 语义配结果行 option；请求仍由防抖词门控） */}
      {hasInput ? (
        <div
          id="mobile-search-listbox"
          role="listbox"
          aria-label="检索结果"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          <SearchResultList
            hits={hits}
            collectionCount={search.data?.collections.length ?? 0}
            loading={
              /* 移动端叠加防误点守卫：换词重取窗口内 keepPreviousData 的旧命中
                 仍是可点 Link（点击即导航+关浮层），宁闪「检索中」也不让旧词
                 命中被当成新词结果点走 */
              loading || (search.isPlaceholderData && search.isFetching)
            }
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
