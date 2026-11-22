'use client';

/**
 * 全局检索共享逻辑（useGlobalSearch）
 *
 * 桌面顶栏下拉检索（components/shell/TopBar）与移动端全屏检索
 * （components/shell/MobileSearch）共用的单一来源：
 * 输入防抖、/api/search 请求、两类命中扁平化为键盘可选列表。
 * open 面板开合也收在这里：桌面由输入框焦点驱动，移动端由顶栏按钮驱动。
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { SOURCE_META } from '@/lib/material-meta';
import type { SearchResults } from '@/features/search/types';

/** 扁平化结果项：材料集/材料两类命中统一成可渲染、可键盘选择的列表项 */
export interface SearchHitItem {
  /** 稳定 key（类型前缀 + id，防两类命中 id 撞车） */
  key: string;
  /** 跳转地址（材料集 → /collection/{id}，材料 → /material/{id}） */
  href: string;
  /** 结果行图标（Material Symbols ligature 名） */
  icon: string;
  /** 展示标题（卷名/材料标题） */
  title: string;
  /** 右侧弱化元信息（材料数 / 所属集 + 字幕状态） */
  meta: string;
}

/** 字幕状态 → 结果行弱化提示（ready 不提示） */
const SUBTITLE_HINT: Record<SearchResults['materials'][number]['subtitleStatus'], string | null> =
  { ready: null, processing: '字幕解析中', none: '未备字幕', failed: '字幕解析失败' };

/** 输入防抖时长（ms）：停顿超过该值才真正发请求 */
const DEBOUNCE_MS = 250;

/**
 * 全局检索 hook：防抖输入 + 检索请求 + 命中扁平化
 */
export function useGlobalSearch() {
  /* raw 是输入原值，q 是防抖后的请求词；open 控制检索面板/浮层开合 */
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  /* 输入防抖：停顿 DEBOUNCE_MS 后才把 raw 落为请求词 q */
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [raw]);

  /* 检索请求：有词才发（enabled 门控；react-query 自带同词去重与缓存） */
  const search = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
  });

  /* 两类命中扁平化（材料集在前、材料在后，与结果分区一致） */
  const hits = useMemo<SearchHitItem[]>(() => {
    if (!search.data) return [];
    const cols = search.data.collections.map((c) => ({
      key: `c${c.id}`,
      href: `/collection/${c.id}`,
      icon: 'shelves',
      title: c.name,
      meta: `${c.materialCount} 篇材料`,
    }));
    const mats = search.data.materials.map((m) => {
      const hint = SUBTITLE_HINT[m.subtitleStatus];
      return {
        key: `m${m.id}`,
        href: `/material/${m.id}`,
        icon: (SOURCE_META[m.sourceType] ?? SOURCE_META.audio).icon,
        title: m.title,
        meta: hint ? `${m.collectionName} · ${hint}` : m.collectionName,
      };
    });
    return [...cols, ...mats];
  }, [search.data]);

  /** 复位检索词（不动 open，面板去留由各场景决定） */
  const reset = () => {
    setRaw('');
    setQ('');
  };

  return { raw, setRaw, q, open, setOpen, search, hits, reset };
}
