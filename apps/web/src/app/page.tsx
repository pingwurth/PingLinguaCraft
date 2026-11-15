'use client';

/**
 * 首页 —— 藏经阁（需求 19：导入材料汇聚地；设计稿 _12/_10）
 *
 * - 统计条：卷数 / 总时长 / 句段总数
 * - 材料集网格（点击进集）+ 新建材料集
 * - 导入入口（去导入向导）
 */

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Collection } from '@/lib/api';

/** ms → 「x 小时 y 分」展示 */
function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分`;
  return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
}

/**
 * 首页组件：藏经阁
 */
export default function HomePage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  /* 材料集列表 */
  const list = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: Collection[] }>('/api/collections'),
  });

  /* 创建材料集 */
  const create = useMutation({
    mutationFn: () =>
      api<{ id: number }>('/api/collections', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setCreating(false);
      setName('');
      setCreateError(null);
      void qc.invalidateQueries({ queryKey: ['collections'] });
    },
    // 创建失败必须可见（此前静默恢复可点，用户无从得知失败原因）
    onError: (err) => setCreateError(err.message),
  });

  const collections = list.data?.collections ?? [];
  const totalMaterials = collections.reduce((a, c) => a + c.materialCount, 0);
  const totalDuration = collections.reduce((a, c) => a + c.totalDurationMs, 0);

  return (
    /* 页面容器：外边距遵循设计系统 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      {/* 页头 */}
      <header className="mb-8">
        <h2 className="font-serif text-2xl md:text-3xl">藏经阁 · 聚纳百卷</h2>
        <p className="mt-1 text-sm text-ochre">书山万仞吾独取，不向旁人问径蹊</p>
      </header>

      {/* 统计条 */}
      <section className="mb-8 grid grid-cols-3 gap-3">
        {[
          { label: '卷帙', value: String(collections.length) },
          { label: '研习时长', value: fmtDuration(totalDuration) },
          { label: '材料', value: String(totalMaterials) },
        ].map((stat) => (
          /* 单个统计卡：纸卡底 + 书边细线 */
          <div key={stat.label} className="deckle rounded-md border bg-card px-4 py-3 text-center">
            <p className="font-serif text-xl">{stat.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </section>

      {/* 操作排：导入 / 新建卷 */}
      <div className="mb-6 flex gap-3">
        <Link
          href="/import"
          className="flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          <span className="material-symbols-outlined text-lg">add</span>
          纳新入卷（导入）
        </Link>
        <button
          onClick={() => setCreating((v) => !v)}
          className="deckle flex items-center gap-2 rounded-md border px-5 py-2.5 text-sm text-secondary transition-colors hover:bg-accent"
        >
          <span className="material-symbols-outlined text-lg">create_new_folder</span>
          另辟新卷
        </button>
      </div>

      {/* 新建卷内联表单（含失败提示） */}
      {creating && (
        <>
        <form
          className="deckle mb-6 flex gap-2 rounded-md border bg-card p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="卷名（如：乔布斯典籍演说）"
            autoFocus
            className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            立卷
          </button>
        </form>
        {/* 立卷失败提示（此前失败静默，表单复位但用户无从感知） */}
        {createError && <p className="mb-6 text-xs text-destructive">{createError}</p>}
        </>
      )}

      {/* 材料集网格 */}
      {list.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : list.isError ? (
        /* 查询失败 ≠ 空库：落到空态会误导用户以为数据丢失 */
        <p className="py-16 text-center text-sm text-destructive">
          藏经阁装载失败：{list.error.message}
        </p>
      ) : collections.length === 0 ? (
        /* 空态引导 */
        <section className="deckle flex flex-col items-center justify-center rounded-md border border-dashed bg-card/50 px-6 py-16 text-center">
          <span className="material-symbols-outlined mb-3 text-4xl text-ochre">library_books</span>
          <p className="font-serif text-lg">尚无卷帙，虚位以待</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            先立一卷，再导入音视频自动生成字幕，或导入文本自动生成音频。
          </p>
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            /* 集卡片：纸卡 + 细线，点击进入 */
            <Link
              key={c.id}
              href={`/collection/${c.id}`}
              className="deckle group flex flex-col rounded-md border bg-card p-5 transition-colors hover:bg-accent/60"
            >
              <div className="flex items-baseline justify-between">
                <h3 className="font-serif text-lg leading-snug">{c.name}</h3>
                {c.cefrLevel && (
                  <span className="rounded-full border border-ochre/40 px-2 py-0.5 text-[10px] text-ochre">
                    {c.cefrLevel}
                  </span>
                )}
              </div>
              {c.description && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
              )}
              <div className="mt-auto flex gap-3 pt-4 text-xs text-ochre">
                <span>{c.materialCount} 篇</span>
                <span>{fmtDuration(c.totalDurationMs)}</span>
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
