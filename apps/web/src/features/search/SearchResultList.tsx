'use client';

/**
 * 检索结果列表（SearchResultList）
 *
 * 桌面顶栏下拉面板与移动端全屏检索共用的结果渲染：
 * 按「材料集 / 名篇材料」两分区展示命中行（hover/键盘高亮同源 activeIndex），
 * 内含加载中 / 检索失败 / 空命中三态。行点击由 Link 自身导航，
 * onSelect 只做调用方的善后（复位检索词、关面板）。
 */

import Link from 'next/link';
import type { SearchHitItem } from '@/features/search/useGlobalSearch';

/** 结果列表 props */
interface SearchResultListProps {
  /** 扁平命中项（材料集在前、材料在后，与 useGlobalSearch 输出一致） */
  hits: SearchHitItem[];
  /** 材料集命中数（分区切分点：前 N 条是材料集，其后是材料） */
  collectionCount: number;
  /** 是否请求中且尚无结果（展示「检索中…」） */
  loading: boolean;
  /** 检索失败消息（非 null 展示错误态；查询失败 ≠ 空命中，不能落空态误导） */
  error: string | null;
  /** aria id 前缀（桌面/移动两实例的 option id 隔离） */
  idPrefix: string;
  /** 键盘/hover 高亮游标（-1 = 未选中；移动端不传即无高亮） */
  activeIndex?: number;
  /** 选中善后回调（Link 导航之外：复位检索词、关面板） */
  onSelect: (href: string) => void;
  /** hover 同步键盘游标（桌面用；移动端不传） */
  onHover?: (index: number) => void;
}

/**
 * 检索结果列表组件：三态 + 两分区命中行
 * @param props 见 SearchResultListProps
 */
export function SearchResultList({
  hits,
  collectionCount,
  loading,
  error,
  idPrefix,
  activeIndex = -1,
  onSelect,
  onHover,
}: SearchResultListProps) {
  if (error) {
    return (
      <p className="px-3 py-6 text-center text-[13px] text-destructive">检索失败：{error}</p>
    );
  }
  if (loading) {
    return <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">检索中…</p>;
  }
  if (hits.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
        未检得相关卷帙或名篇
      </p>
    );
  }

  const collections = hits.slice(0, collectionCount);
  const materials = hits.slice(collectionCount);

  return (
    <>
      {/* 材料集分区 */}
      {collections.length > 0 ? (
        <div className="py-1">
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-ochre">
            材料集
          </p>
          {collections.map((hit, i) => (
            <Link
              key={hit.key}
              id={`${idPrefix}-option-${i}`}
              role="option"
              aria-selected={activeIndex === i}
              href={hit.href}
              onClick={() => onSelect(hit.href)}
              onMouseEnter={() => onHover?.(i)}
              className={`flex items-center gap-2.5 px-3 py-2.5 ${
                activeIndex === i ? 'bg-accent' : ''
              }`}
            >
              <span className="material-symbols-outlined shrink-0 text-lg text-primary">
                {hit.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{hit.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{hit.meta}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {/* 材料分区（列表索引接在材料集之后，键盘游标连续） */}
      {materials.length > 0 ? (
        <div className="py-1">
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-ochre">
            名篇材料
          </p>
          {materials.map((hit, i) => {
            const idx = collectionCount + i;
            return (
              <Link
                key={hit.key}
                id={`${idPrefix}-option-${idx}`}
                role="option"
                aria-selected={activeIndex === idx}
                href={hit.href}
                onClick={() => onSelect(hit.href)}
                onMouseEnter={() => onHover?.(idx)}
                className={`flex items-center gap-2.5 px-3 py-2.5 ${
                  activeIndex === idx ? 'bg-accent' : ''
                }`}
              >
                <span className="material-symbols-outlined shrink-0 text-lg text-primary">
                  {hit.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{hit.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{hit.meta}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
