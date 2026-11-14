'use client';

/**
 * 导入向导页（需求 1/2/3；设计稿 _15 移动 / _14 桌面）
 *
 * 三种导入路径（tab 切换）：
 * - 本地文件：音视频（+可选字幕文件，有字幕免 STT）
 * - 链接：YouTube/Bilibili/TED/RSS（yt-dlp 下载，顺带抓官方英文字幕）
 * - 文本：粘贴英文文本 → 自动分句 → TTS 生成音频
 * 公共：选择目标材料集（或快速新建）
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Collection, type JobDTO } from '@/lib/api';

/** 导入路径 tab */
type ImportKind = 'file' | 'link' | 'text';

/**
 * 导入页（Suspense 包装 useSearchParams）
 */
export default function ImportPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-sm text-muted-foreground">装载中…</div>}>
      <ImportWizard />
    </Suspense>
  );
}

/**
 * 导入向导主体
 */
function ImportWizard() {
  const search = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ImportKind>('file');
  const [collectionId, setCollectionId] = useState<number>(Number(search.get('collectionId')) || 0);
  const [newCollection, setNewCollection] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [wantVideo, setWantVideo] = useState(true);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ materialId: number; jobId: string } | null>(null);

  /* 材料集列表 */
  const collections = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: Collection[] }>('/api/collections'),
  });

  /* 任务进度（提交后轮询；完成跳转播放页） */
  const job = useQuery({
    queryKey: ['job', result?.jobId],
    queryFn: () => api<{ job: JobDTO }>(`/api/jobs/${result!.jobId}`),
    enabled: !!result,
    refetchInterval: (q) => {
      const st = q.state.data?.job.status;
      return st === 'succeeded' || st === 'failed' ? false : 1500;
    },
  });

  /* 提交成功后刷新列表 + 成功时跳转 */
  const onSubmitSuccess = (r: { materialId: number; jobId: string }) => {
    setResult(r);
    void qc.invalidateQueries({ queryKey: ['collections'] });
  };

  /* 提交后自动跳转到播放页（任务完成时） */
  if (result && job.data?.job.status === 'succeeded') {
    router.push(`/material/${result.materialId}`);
  }

  /* 三种提交 */
  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('file', file!);
      if (subtitleFile) fd.set('subtitle', subtitleFile);
      fd.set('collectionId', String(collectionId));
      return fetch('/api/import/upload', { method: 'POST', body: fd }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? '上传失败');
        return data as { materialId: number; jobId: string };
      });
    },
    onSuccess: onSubmitSuccess,
  });
  const link = useMutation({
    mutationFn: () =>
      api<{ materialId: number; jobId: string }>('/api/import/link', {
        method: 'POST',
        body: JSON.stringify({ url: linkUrl, collectionId, wantVideo }),
      }),
    onSuccess: onSubmitSuccess,
  });
  const textImport = useMutation({
    mutationFn: () =>
      api<{ materialId: number; jobId: string }>('/api/import/text', {
        method: 'POST',
        body: JSON.stringify({ text, collectionId }),
      }),
    onSuccess: onSubmitSuccess,
  });

  /* 快速建卷 */
  const createCollection = useMutation({
    mutationFn: () => api<{ id: number }>('/api/collections', { method: 'POST', body: JSON.stringify({ name: newCollection }) }),
    onSuccess: (r) => {
      setCollectionId(r.id);
      setNewCollection('');
      void collections.refetch();
    },
  });

  const pending = upload.isPending || link.isPending || textImport.isPending;
  const errMsg =
    (upload.error ?? link.error ?? textImport.error ?? createCollection.error) instanceof Error
      ? ((upload.error ?? link.error ?? textImport.error ?? createCollection.error) as Error).message
      : null;

  const canSubmit =
    collectionId > 0 &&
    !pending &&
    (kind === 'file' ? !!file : kind === 'link' ? /^https?:\/\//.test(linkUrl) : text.trim().length > 10);

  return (
    /* 向导容器 */
    <div className="mx-auto w-full max-w-2xl px-5 py-6 md:py-10">
      {/* 页头 */}
      <header className="mb-6">
        <h2 className="font-serif text-2xl">纳新入卷</h2>
        <p className="mt-1 text-sm text-ochre">导入后自动生成字幕与译文，即可开始精读</p>
      </header>

      {/* 路径 tab */}
      <nav className="deckle mb-5 flex rounded-md border bg-card p-1">
        {(
          [
            ['file', '本地文件', 'upload_file'],
            ['link', '链接导入', 'link'],
            ['text', '文本转音频', 'text_to_speech'],
          ] as Array<[ImportKind, string, string]>
        ).map(([key, label, icon]) => (
          <button
            key={key}
            onClick={() => setKind(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-2 text-sm transition-colors ${
              kind === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            <span className="material-symbols-outlined text-lg">{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* 目标材料集选择（三路共用） */}
      <section className="deckle mb-5 rounded-md border bg-card p-4">
        <label className="mb-2 block text-sm font-medium">归属材料集</label>
        <div className="flex gap-2">
          <select
            value={collectionId || ''}
            onChange={(e) => setCollectionId(Number(e.target.value))}
            className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">选择材料集…</option>
            {(collections.data?.collections ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {/* 快速建卷 */}
        <div className="mt-2 flex gap-2">
          <input
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
            placeholder="或输入新卷名快速立卷"
            className="flex-1 rounded border border-input bg-background px-3 py-1.5 text-xs"
          />
          <button
            onClick={() => newCollection.trim() && createCollection.mutate()}
            disabled={!newCollection.trim() || createCollection.isPending}
            className="rounded border border-secondary px-3 py-1.5 text-xs text-secondary disabled:opacity-40"
          >
            立卷
          </button>
        </div>
      </section>

      {/* 各路径输入区 */}
      {kind === 'file' && (
        <section className="deckle mb-5 rounded-md border bg-card p-4">
          <label className="mb-2 block text-sm font-medium">音视频文件</label>
          <input
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          />
          {file && (
            <p className="mt-2 text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
          <label className="mb-2 mt-4 block text-sm font-medium">
            字幕文件（可选，有英文字幕则跳过 STT）
          </label>
          <input
            type="file"
            accept=".srt,.vtt"
            onChange={(e) => setSubtitleFile(e.target.files?.[0] ?? null)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          />
        </section>
      )}

      {kind === 'link' && (
        <section className="deckle mb-5 rounded-md border bg-card p-4">
          <label className="mb-2 block text-sm font-medium">链接（YouTube / Bilibili / TED / RSS）</label>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://…"
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
          />
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={wantVideo} onChange={(e) => setWantVideo(e.target.checked)} className="size-4 accent-[#b91c1c]" />
            下载视频（取消则仅下载音频，更快）
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            若站点提供英文字幕将直接采用（免转写）；否则本地 whisper 转写。
          </p>
        </section>
      )}

      {kind === 'text' && (
        <section className="deckle mb-5 rounded-md border bg-card p-4">
          <label className="mb-2 block text-sm font-medium">英文文本（自动分句并合成英音音频）</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="粘贴文章、演讲稿或任何英文文本…"
            className="min-h-40 w-full rounded border border-input bg-background p-3 font-serif text-sm"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{text.trim().length} 字符</p>
        </section>
      )}

      {/* 错误提示 */}
      {errMsg && <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{errMsg}</p>}

      {/* 提交按钮 / 进度面板 */}
      {!result ? (
        <button
          onClick={() => (kind === 'file' ? upload.mutate() : kind === 'link' ? link.mutate() : textImport.mutate())}
          disabled={!canSubmit}
          className="w-full rounded-md bg-primary py-3 text-sm text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {pending ? '提交中…' : '开始导入'}
        </button>
      ) : (
        /* 提交后：任务进度（页面停留提示 + 完成自动跳转） */
        <div className="deckle rounded-md border bg-card p-5">
          <p className="text-sm">
            {job.data?.job.status === 'failed'
              ? '导入失败'
              : job.data?.job.status === 'succeeded'
                ? '完成，正在进入精读页…'
                : (job.data?.job.message ?? '任务排队中…')}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: `${Math.max(3, (job.data?.job.progress ?? 0) * 100)}%` }}
            />
          </div>
          {job.data?.job.status === 'failed' && (
            <>
              <p className="mt-2 break-all text-xs text-destructive">{job.data?.job.error}</p>
              <button
                onClick={() => {
                  setResult(null);
                  void qc.invalidateQueries({ queryKey: ['collections'] });
                }}
                className="mt-3 rounded-md border border-border px-4 py-2 text-xs"
              >
                返回修改重试
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
