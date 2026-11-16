'use client';

/**
 * 材料集详情页（需求 19 分页；设计稿 _13/_11）
 *
 * - 材料卡片：标题、状态（处理中/就绪/失败）、时长、句数/词数、来源类型
 * - 就绪材料点击进入精读播放；处理中显示内联进度（任务轮询）
 * - 分页控件（上一页/下一页）
 */

import Link from 'next/link';
import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Collection, type JobDTO, type MaterialListItem } from '@/lib/api';
import { SOURCE_META } from '@/lib/material-meta';

/** ms → mm:ss */
function fmtMs(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 来源类型 → 图标与中文：见 lib/material-meta（与首页流动动向共用单源） */

/**
 * 材料集详情页
 * @param props.params 路由参数（集 id）
 */
export default function CollectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const collectionId = Number(id);
  const [page, setPage] = useState(1);

  /* 集详情 */
  const detail = useQuery({
    queryKey: ['collection', collectionId],
    queryFn: () => api<{ collection: Collection }>(`/api/collections/${collectionId}`),
  });

  /* 材料分页 */
  const list = useQuery({
    queryKey: ['materials', collectionId, page],
    queryFn: () =>
      api<{ materials: MaterialListItem[]; total: number; totalPages: number }>(
        `/api/collections/${collectionId}/materials?page=${page}&pageSize=20`
      ),
    refetchInterval: (q) =>
      q.state.data?.materials.some((m) => m.subtitleStatus === 'processing') ? 2500 : false,
  });

  const materials = list.data?.materials ?? [];

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      {/* 页头：返回 + 卷名 + 导入到本卷 */}
      <header className="mb-6 flex items-center gap-3">
        <Link href="/" aria-label="返回藏经阁" className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-primary">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-serif text-2xl">{detail.data?.collection.name ?? '…'}</h2>
        </div>
        <Link
          href={`/import?collectionId=${collectionId}`}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          <span className="material-symbols-outlined text-lg">add</span>
          导入
        </Link>
      </header>

      {/* 材料列表 */}
      {list.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : list.isError ? (
        /* 查询失败 ≠ 此卷尚空：落到空态会误报空卷 */
        <p className="py-16 text-center text-sm text-destructive">材料装载失败：{list.error.message}</p>
      ) : materials.length === 0 ? (
        <div className="deckle rounded-md border border-dashed bg-card/50 px-6 py-16 text-center">
          <p className="font-serif text-lg">此卷尚空</p>
          <p className="mt-1 text-sm text-muted-foreground">导入音视频、文本或链接，开始研习。</p>
        </div>
      ) : (
        <section className="flex flex-col gap-3">
          {materials.map((m) => (
            <MaterialCard key={m.id} material={m} />
          ))}
        </section>
      )}

      {/* 分页控件 */}
      {(list.data?.totalPages ?? 1) > 1 && (
        <div className="mt-6 flex items-center justify-center gap-4 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="deckle rounded-md border px-3 py-1.5 disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-muted-foreground">
            {page} / {list.data?.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(list.data?.totalPages ?? 1, p + 1))}
            disabled={page >= (list.data?.totalPages ?? 1)}
            className="deckle rounded-md border px-3 py-1.5 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 单张材料卡（含处理中进度）
 */
function MaterialCard({ material }: { material: MaterialListItem }) {
  /* 处理中：轮询该材料的活跃任务拿进度文案 */
  const jobs = useQuery({
    queryKey: ['jobs', material.id],
    queryFn: () => api<{ jobs: JobDTO[] }>(`/api/jobs?materialId=${material.id}`),
    enabled: material.subtitleStatus === 'processing',
    refetchInterval: 2000,
  });
  const job = jobs.data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const meta = SOURCE_META[material.sourceType] ?? SOURCE_META.audio!;

  const ready = material.subtitleStatus === 'ready';
  const body = (
    <>
      {/* 状态角标 */}
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] ${
          ready
            ? 'bg-secondary/10 text-secondary'
            : material.subtitleStatus === 'processing'
              ? 'bg-primary/10 text-primary'
              : material.subtitleStatus === 'failed'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground'
        }`}
      >
        {ready ? '可研习' : material.subtitleStatus === 'processing' ? '生成中' : material.subtitleStatus === 'failed' ? '失败' : '待处理'}
      </span>
    </>
  );

  return (
    /* 卡片：可点击（就绪→播放页；其他→提示行内状态） */
    <div className="deckle rounded-md border bg-card p-4">
      <div className="flex items-start gap-3">
        {/* 来源类型图标块 */}
        <div className="deckle flex size-11 shrink-0 items-center justify-center rounded-md border bg-background">
          <span className="material-symbols-outlined text-xl text-ochre">{meta.icon}</span>
        </div>
        {/* 主体信息 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-serif text-base">{material.title}</h3>
            <span className="ml-auto shrink-0">{body}</span>
          </div>
          <p className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>{meta.label}</span>
            <span>{fmtMs(material.mediaDurationMs)}</span>
            {material.sentenceCount != null && <span>{material.sentenceCount} 句</span>}
            {material.uniqueWordCount != null && <span>{material.uniqueWordCount} 词</span>}
          </p>
          {/* 处理中：内联进度条 */}
          {material.subtitleStatus === 'processing' && (
            <div className="mt-2">
              <div className="flex justify-between text-[11px] text-ochre">
                <span>{job?.message ?? '排队中…'}</span>
                {job && <span>{Math.round(job.progress * 100)}%</span>}
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.max(3, (job?.progress ?? 0) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {/* 就绪：入口行 */}
      {ready ? (
        <Link
          href={`/material/${material.id}`}
          className="mt-3 flex items-center justify-center gap-2 rounded-md bg-primary py-2 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          <span className="material-symbols-outlined text-lg">auto_stories</span>
          进入精读
        </Link>
      ) : material.subtitleStatus === 'failed' ? (
        <Link
          href={`/material/${material.id}`}
          className="mt-3 block rounded-md border border-destructive/40 py-2 text-center text-sm text-destructive"
        >
          查看失败原因
        </Link>
      ) : null}
    </div>
  );
}
