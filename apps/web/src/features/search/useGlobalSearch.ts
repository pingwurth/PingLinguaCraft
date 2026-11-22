'use client';

/**
 * 全局检索共享逻辑（useGlobalSearch）
 *
 * 桌面顶栏下拉检索（components/shell/TopBar）与移动端全屏检索
 * （components/shell/MobileSearch）共用的单一来源：
 * 输入防抖、/api/search 请求、两类命中扁平化为键盘可选列表。
 * 面板开合不收在这里（各场景驱动方式不同：桌面输入焦点 / 移动按钮），
 * 由调用方自持 state。
 */

import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { SOURCE_META, subtitleStatusMeta } from '@/lib/material-meta';
import type { SearchResults } from '@/features/search/types';
import { SEARCH_QUERY_MAX } from '@/lib/limits';

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

/** 检索槽占位文案（桌面带 ⌘K 快捷键提示，移动端未绑定快捷键不带） */
export const SEARCH_PLACEHOLDER = {
  desktop: '搜寻典籍与名篇 (⌘K)…',
  mobile: '搜寻典籍与名篇…',
} as const;

/** 输入防抖时长（ms）：停顿超过该值才真正发请求 */
const DEBOUNCE_MS = 250;

/**
 * 检索词归一（防抖落定与「防抖中」判定共用同一口径）：去首尾空白、按共享
 * 上限截断（截在代理对中间时去掉末尾落单的高位代理——孤立代理项会让
 * encodeURIComponent 抛 URIError，界面报「检索失败：URI malformed」）
 * @param raw 输入原值
 */
function normalizeQuery(raw: string): string {
  const sliced = raw.trim().slice(0, SEARCH_QUERY_MAX);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * 全局检索 hook：防抖输入 + 检索请求 + 命中扁平化
 */
export function useGlobalSearch() {
  /* raw 是输入原值，q 是防抖后的请求词 */
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');

  /* 输入防抖：停顿 DEBOUNCE_MS 后才把归一化的 raw 落为请求词 q */
  useEffect(() => {
    const t = setTimeout(() => setQ(normalizeQuery(raw)), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [raw]);

  /* 检索请求：有词才发（enabled 门控；react-query 自带同词去重与缓存；
     keepPreviousData：换词时保留上一轮结果，面板不闪「检索中…」） */
  const search = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });

  /* 两类命中扁平化（材料集在前、材料在后，与结果分区一致；字幕状态提示
     复用 material-meta 单源，与列表页措辞一致） */
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
      /* 检索行无图标承载主体，提示补「字幕」前缀（「集名 · 字幕解析中」而非语义悬空的「解析中」） */
      const hint = m.subtitleStatus === 'ready' ? null : `字幕${subtitleStatusMeta(m.subtitleStatus).label}`;
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

  /** 复位检索词 */
  const reset = () => {
    setRaw('');
    setQ('');
  };

  /* 防抖未落定判定（与落定同用 normalizeQuery 口径——拿 raw 原值直比 q 的
     话，超过 SEARCH_QUERY_MAX 的输入截断后永远 ≠ raw，「检索中…」卡死） */
  const debouncing = normalizeQuery(raw) !== q;
  /* 「换词重取窗口内旧命中仍挂着」（keepPreviousData）：桌面下拉刻意保持
     可点（点击=承认旧词结果），移动端点击即导航须防误点——谓词收在 hook，
     两端按各自交互语义取舍，不再各自重组 */
  const staleWhileFetching = search.isPlaceholderData && search.isFetching;
  /* 加载态基础谓词（双端共用单源）：防抖未落定，或首查在途（尚无任何数据） */
  const loading = debouncing || (!search.data && search.isFetching);

  return { raw, setRaw, q, search, hits, reset, debouncing, loading, staleWhileFetching };
}
