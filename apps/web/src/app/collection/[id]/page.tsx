'use client';

/**
 * 材料集详情页（需求 19 分页；设计稿 _13/_11）
 *
 * - 材料卡片：标题、状态（处理中/就绪/失败）、时长、句数/词数、来源类型
 * - 就绪材料点击进入精读播放；处理中显示内联进度（任务轮询）
 * - 移动材料：卡片动作行「移动到其他卷」，弹窗选目标卷（PATCH /api/materials/[id]
 *   的 collectionId 移动语义；媒体/波形/录音/研读进度随迁，处理中禁移）
 * - 分页控件（上一页/下一页）
 * - 编辑本卷：页头入口跳藏经阁 /library?edit=<id> 深链，由藏经阁弹窗编辑模式承载
 *   全部装帧表单（单一表单实现，避免两处维护）
 * - 删除本卷：页头删除入口（纸墨风确认弹窗 ConfirmDialog 交代级联后果后
 *   物理删卷与卷内材料/媒体，成功后跳回藏经阁）
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Collection, type JobDTO, type MaterialListItem } from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SOURCE_META } from '@/lib/material-meta';
import { fmtMs } from '@/lib/format';
import { MATERIAL_PAGE_DEFAULT } from '@/lib/limits';
import { HOME_QUERY_KEY } from '@/features/home/query-keys';

/**
 * 材料集详情页
 * @param props.params 路由参数（集 id）
 */
export default function CollectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const collectionId = Number(id);
  const [page, setPage] = useState(1);
  /* 移动材料弹窗：非空即弹窗打开（承载待移动材料） */
  const [moving, setMoving] = useState<MaterialListItem | null>(null);
  const router = useRouter();
  const qc = useQueryClient();

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
        `/api/collections/${collectionId}/materials?page=${page}&pageSize=${MATERIAL_PAGE_DEFAULT}`
      ),
    refetchInterval: (q) =>
      q.state.data?.materials.some((m) => m.subtitleStatus === 'processing') ? 2500 : false,
  });

  const materials = list.data?.materials ?? [];

  /* 移动材料（PATCH /api/materials/[id] 的 collectionId 移动语义）：
   * 成功后失效材料列表/卷详情/藏经阁/首页/卷列表缓存（materialCount 等随之刷新） */
  const moveMaterial = useMutation({
    mutationFn: (v: { materialId: number; targetId: number }) =>
      api(`/api/materials/${v.materialId}`, {
        method: 'PATCH',
        body: JSON.stringify({ collectionId: v.targetId }),
      }),
    onSuccess: () => {
      setMoving(null);
      /* 本卷末页仅剩这一篇时回退一页，避免落在空页 */
      if (materials.length === 1 && page > 1) setPage((p) => p - 1);
      void qc.invalidateQueries({ queryKey: ['materials'] });
      void qc.invalidateQueries({ queryKey: ['collection'] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      void qc.invalidateQueries({ queryKey: HOME_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ['focus-materials'] });
    },
    // 移动失败必须可见（静默时用户以为已移走，切卷才发现材料还在）
    onError: (err) => alert(`移动失败：${err.message}`),
  });

  /* 目标卷候选（弹窗打开才拉取，与导入页共用 ['collections'] 缓存） */
  const colsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: Collection[] }>('/api/collections'),
    enabled: moving !== null,
  });
  const moveTargets = (colsQuery.data?.collections ?? []).filter((c) => c.id !== collectionId);

  /* 删除本卷（物理删：级联清卷内材料/字幕与媒体目录；DELETE /api/collections/[id]） */
  const remove = useMutation({
    mutationFn: () => api(`/api/collections/${collectionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      /* 卷已删：失效首页聚合并跳回藏经阁（停留本页会让详情查询 404） */
      void qc.invalidateQueries({ queryKey: HOME_QUERY_KEY });
      router.replace('/library');
    },
    // 删除失败必须可见（静默时用户以为已删，重进才知卷还在；确认弹窗保持打开可取消）
  });

  /* 删除确认弹窗开关（卷详情未载入前不允许开——级联后果文案需卷名与篇数） */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const col = detail.data?.collection;

  /** 打开删除确认弹窗（级联后果与不可恢复在弹窗正文交代） */
  const confirmRemove = () => {
    setConfirmOpen(true);
  };

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      {/* 页头：返回 + 卷名 + 导入到本卷 */}
      <header className="mb-6 flex items-center gap-3">
        <Link href="/library" aria-label="返回藏经阁" className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-primary">
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
        {/* 编辑本卷：跳藏经阁深链自动打开编辑弹窗（表单在藏经阁页单处维护） */}
        <Link
          href={`/library?edit=${collectionId}`}
          aria-label="编辑本卷"
          title="编辑本卷"
          className="flex size-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-primary"
        >
          <span className="material-symbols-outlined text-lg">edit</span>
        </Link>
        {/* 删除本卷：confirm 确认级联后果（卷名未载入/删除进行中禁用） */}
        <button
          onClick={confirmRemove}
          disabled={!detail.data || remove.isPending}
          aria-label="删除本卷"
          title="删除本卷"
          className="flex size-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
        >
          {/* 删除中换沙漏示忙（防误以为没点上重复点） */}
          <span aria-hidden className="material-symbols-outlined text-lg">
            {remove.isPending ? 'hourglass_empty' : 'delete'}
          </span>
        </button>
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
            <MaterialCard key={m.id} material={m} onMove={() => setMoving(m)} />
          ))}
        </section>
      )}

      {/* 移动材料弹窗：点遮罩/取消关闭；逐卷点选即提交（进行中禁点防重复提交） */}
      {moving && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-5"
          onClick={() => setMoving(null)}
        >
          {/* 弹窗主体：阻断冒泡避免点内容误关 */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`移动材料「${moving.title}」`}
            className="deckle w-full max-w-sm rounded-md border bg-card p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="truncate font-serif text-lg">移动「{moving.title}」</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              选择目标卷：媒体、跟读录音与研读进度随材料一并迁移；处理中的材料暂不可移动。
            </p>
            <div className="mt-4 flex max-h-72 flex-col gap-1 overflow-y-auto">
              {colsQuery.isLoading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">装载中…</p>
              ) : colsQuery.isError ? (
                /* 装载失败 ≠ 空库：如实报错，否则用户被误导去藏经阁立卷 */
                <p className="py-6 text-center text-sm text-destructive">
                  目标卷列表装载失败：{colsQuery.error.message}
                </p>
              ) : moveTargets.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  库中暂无其他卷，先去藏经阁立卷。
                </p>
              ) : (
                moveTargets.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={moveMaterial.isPending}
                    onClick={() => moveMaterial.mutate({ materialId: moving.id, targetId: c.id })}
                    className="deckle flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent/60 disabled:opacity-50"
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {c.materialCount} 篇
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setMoving(null)}
                className="deckle rounded-md border px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                取消
              </button>
            </div>
          </div>
        </div>
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

      {/* 删除确认弹窗（纸墨风共享 ConfirmDialog，替代原生 confirm）：与藏经阁删除
          入口同一弹窗同一文案口径；成功后跳回藏经阁，失败保持打开可取消/重试 */}
      <ConfirmDialog
        open={confirmOpen && col !== undefined}
        title="删除材料集"
        icon="delete_forever"
        confirmLabel="确认删除"
        destructive
        pending={remove.isPending}
        error={remove.isError ? remove.error.message : null}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          setConfirmOpen(false);
          remove.reset();
        }}
        body={
          <>
            <p>
              将删除材料集
              <span className="mx-1 font-serif text-title-sm font-bold text-on-surface">
                「{col?.name ?? ''}」
              </span>
            </p>
            {(col?.materialCount ?? 0) > 0 && (
              <p className="mt-2 rounded-sm bg-muted px-3 py-2">
                卷内 {col?.materialCount} 篇材料，字幕与媒体文件将一并永久删除，
                <span className="font-semibold text-destructive">不可恢复</span>。
              </p>
            )}
          </>
        }
      />
    </div>
  );
}

/**
 * 单张材料卡（含处理中进度与移动入口）
 * @param props.material 材料条目
 * @param props.onMove 移动入口回调（弹窗在父层承载，confirm 语义移动无破坏性故免确认）
 */
function MaterialCard({ material, onMove }: { material: MaterialListItem; onMove: () => void }) {
  /* 处理中：轮询该材料的活跃任务拿进度文案 */
  const jobs = useQuery({
    queryKey: ['jobs', material.id],
    queryFn: () => api<{ jobs: JobDTO[] }>(`/api/jobs?materialId=${material.id}`),
    enabled: material.subtitleStatus === 'processing',
    refetchInterval: 2000,
  });
  const job = jobs.data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const meta = SOURCE_META[material.sourceType] ?? SOURCE_META.audio!;
  /* 处理中禁移：进行中任务以绝对路径写产物，迁移会散落旧路径（服务端 409 同口径） */
  const processing = material.subtitleStatus === 'processing';

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
      {/* 动作行：主入口（就绪→精读 / 失败→原因）+ 移动到其他卷 */}
      <div className="mt-3 flex items-stretch gap-2">
        {ready ? (
          <Link
            href={`/material/${material.id}`}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary py-2 text-sm text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <span className="material-symbols-outlined text-lg">auto_stories</span>
            进入精读
          </Link>
        ) : material.subtitleStatus === 'failed' ? (
          <Link
            href={`/material/${material.id}`}
            className="flex flex-1 items-center justify-center rounded-md border border-destructive/40 py-2 text-center text-sm text-destructive transition-colors hover:bg-destructive/5"
          >
            查看失败原因
          </Link>
        ) : null}
        {/* 移动：弹窗选目标卷；处理中禁用并注明原因 */}
        <button
          type="button"
          onClick={onMove}
          disabled={processing}
          aria-label={`移动「${material.title}」到其他卷`}
          title={processing ? '字幕处理中，暂不能移动' : '移动到其他卷'}
          className="deckle flex size-10 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span aria-hidden className="material-symbols-outlined text-lg">
            drive_file_move
          </span>
        </button>
      </div>
    </div>
  );
}
