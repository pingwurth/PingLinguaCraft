'use client';

/**
 * 句藏页（需求 13：句子收藏自定义分类、AI 解析查看/重新生成、笔记）
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { api } from '@/lib/api';

/** 分类形态 */
interface CategoryDTO {
  id: number;
  name: string;
}

/** 收藏形态 */
interface FavoriteDTO {
  id: number;
  cueId: number;
  categoryId: number | null;
  aiAnalysisMd: string | null;
  aiAnalysisStatus: 'none' | 'pending' | 'ready' | 'failed';
  noteMd: string | null;
  textEn: string | null;
  textZh: string | null;
  materialId: number | null;
  materialTitle: string | null;
}

/**
 * 句藏页组件
 */
export default function FavoritesPage() {
    const [filterCat, setFilterCat] = useState<number | null>(null);
  const [newCat, setNewCat] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  /* 收藏 + 分类 */
  const list = useQuery({
    queryKey: ['favorites', filterCat],
    queryFn: () =>
      api<{ favorites: FavoriteDTO[]; categories: CategoryDTO[] }>(
        filterCat ? `/api/favorites?categoryId=${filterCat}` : '/api/favorites'
      ),
    refetchInterval: (q) =>
      q.state.data?.favorites.some((f) => f.aiAnalysisStatus === 'pending') ? 2500 : false,
  });

  /* 建分类 */
  const createCat = useMutation({
    mutationFn: () => api('/api/favorite-categories', { method: 'POST', body: JSON.stringify({ name: newCat }) }),
    onSuccess: () => {
      setNewCat('');
      void list.refetch();
    },
  });

  /* 重新生成解析 */
  const reanalyze = useMutation({
    mutationFn: (id: number) => api(`/api/favorites/${id}?action=reanalyze`, { method: 'POST' }),
    onSuccess: () => void list.refetch(),
  });

  /* 改分类 */
  const changeCat = useMutation({
    mutationFn: (v: { id: number; categoryId: number | null }) =>
      api(`/api/favorites/${v.id}`, { method: 'PATCH', body: JSON.stringify({ categoryId: v.categoryId }) }),
    onSuccess: () => void list.refetch(),
  });

  const cats = list.data?.categories ?? [];
  const favs = list.data?.favorites ?? [];

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-4xl px-5 py-6 md:px-12 md:py-10">
      <header className="mb-6">
        <h2 className="font-serif text-2xl md:text-3xl">句藏</h2>
        <p className="mt-1 text-sm text-ochre">播放页「AI 解析并收藏」的句子汇聚于此</p>
      </header>

      {/* 分类筛选条 + 新建分类 */}
      <div className="deckle mb-5 flex flex-wrap items-center gap-2 rounded-md border bg-card p-2">
        {/* 全部分类 */}
        <button
          onClick={() => setFilterCat(null)}
          className={`rounded-full px-3 py-1 text-xs ${filterCat === null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
        >
          全部
        </button>
        {cats.map((c) => (
          <button
            key={c.id}
            onClick={() => setFilterCat(c.id)}
            className={`rounded-full px-3 py-1 text-xs ${filterCat === c.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
          >
            {c.name}
          </button>
        ))}
        {/* 新建分类 */}
        <form
          className="ml-auto flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (newCat.trim()) createCat.mutate();
          }}
        >
          <input
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            placeholder="新分类"
            className="w-24 rounded-full border border-input bg-background px-3 py-1 text-xs"
          />
          <button type="submit" className="rounded-full border border-secondary/50 px-3 py-1 text-xs text-secondary">
            建
          </button>
        </form>
      </div>

      {/* 收藏列表 */}
      {favs.length === 0 ? (
        <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
          <p className="font-serif">尚无藏句</p>
          <p className="mt-1 text-xs text-muted-foreground">在播放页的「当前句」里点「AI 解析并收藏」</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {favs.map((f) => (
            /* 单条收藏卡 */
            <article key={f.id} className="deckle rounded-md border bg-card p-4">
              {/* 原句 + 出处 */}
              <Link_ materialId={f.materialId} title={f.materialTitle} />
              <p className="font-serif text-base leading-relaxed">{f.textEn}</p>
              {f.textZh && <p className="mt-1 text-sm text-muted-foreground">{f.textZh}</p>}
              {/* 元信息排：分类下拉 + 重新生成 */}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={f.categoryId ?? ''}
                  onChange={(e) =>
                    changeCat.mutate({ id: f.id, categoryId: e.target.value ? Number(e.target.value) : null })
                  }
                  className="rounded border border-input bg-background px-2 py-1"
                >
                  <option value="">未分类</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => reanalyze.mutate(f.id)}
                  className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-muted-foreground hover:text-primary"
                >
                  <span className="material-symbols-outlined text-sm">auto_awesome</span>
                  {f.aiAnalysisStatus === 'ready' ? '重新解析' : '生成解析'}
                </button>
                {f.aiAnalysisStatus === 'pending' && <span className="text-primary">解析中…</span>}
                {expanded !== f.id && f.aiAnalysisStatus === 'ready' && (
                  <button onClick={() => setExpanded(f.id)} className="ml-auto text-muted-foreground">
                    展开解析 ▾
                  </button>
                )}
                {expanded === f.id && (
                  <button onClick={() => setExpanded(null)} className="ml-auto text-muted-foreground">
                    收起 ▴
                  </button>
                )}
              </div>
              {/* AI 解析内容 */}
              {expanded === f.id && (
                <div className="mt-3 border-t border-border pt-3">
                  <MarkdownView source={f.aiAnalysisMd} />
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/** 出处链接（可跳播放页；无材料时纯文本） */
function Link_({ materialId, title }: { materialId: number | null; title: string | null }) {
  if (!materialId) return null;
  return (
    <a
      href={`/material/${materialId}`}
      className="mb-1 inline-flex items-center gap-1 text-[11px] text-ochre hover:text-primary"
    >
      <span className="material-symbols-outlined text-sm">menu_book</span>
      {title ?? '出处'}
    </a>
  );
}
