'use client';

/**
 * 精读播放页（M1 核心页面，设计稿 _1 移动 / ai_1 桌面）
 *
 * 结构（移动端自上而下）：sticky 播放器 → 句段标签条（当前句/双语精读，
 * M2 增听写/跟读/测验）→ 滚动内容区。桌面端播放器与内容左右分栏（md+）。
 * 字幕未就绪时显示处理进度（任务轮询）。
 */

import { use, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Player } from '@/features/player/Player';
import { CurrentSentenceTab } from '@/features/reading/CurrentSentenceTab';
import { BilingualTab } from '@/features/reading/BilingualTab';
import { DictationTab } from '@/features/practice/DictationTab';
import { ShadowingTab } from '@/features/practice/ShadowingTab';
import { QuizTab } from '@/features/practice/QuizTab';
import { usePlayer } from '@/features/player/store';
import { api, type CueDTO, type JobDTO, type MaterialDetail, type ProgressDTO } from '@/lib/api';

/** 标签页标识（需求 7：当前句/双语精读/听写/跟读/测验） */
type TabKey = 'current' | 'bilingual' | 'dictation' | 'shadowing' | 'quiz';

/**
 * 播放页
 * @param props.params 路由参数（材料 id）
 */
export default function MaterialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const materialId = Number(id);
  const [tab, setTab] = useState<TabKey>('current');
  // 激活句订阅（仅取 activeCueIndex，粒度最小化）
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);

  /* 材料详情（含进度） */
  const detail = useQuery({
    queryKey: ['material', materialId],
    queryFn: () =>
      api<{ material: MaterialDetail; progress: ProgressDTO | null }>(`/api/materials/${materialId}`),
  });

  /* 句段全量 */
  const cuesQuery = useQuery({
    queryKey: ['cues', materialId],
    queryFn: () => api<{ cues: CueDTO[] }>(`/api/materials/${materialId}/cues`),
    enabled: detail.data?.material.subtitleStatus === 'ready',
  });

  /* 字幕处理中：任务进度轮询（导入/重STT/重译） */
  const jobs = useQuery({
    queryKey: ['jobs', materialId, 'processing'],
    queryFn: () => api<{ jobs: JobDTO[] }>(`/api/jobs?materialId=${materialId}`),
    enabled: detail.data?.material.subtitleStatus === 'processing',
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : false,
  });
  // 任务到终态后刷新材料状态（processing → ready/failed）
  useEffect(() => {
    const list = jobs.data?.jobs;
    if (list && list.some((j) => j.status === 'succeeded' || j.status === 'failed')) {
      void detail.refetch();
    }
  }, [jobs.data, detail]);

  if (detail.isLoading) {
    return <div className="p-10 text-center text-sm text-muted-foreground">装载中…</div>;
  }
  if (detail.isError || !detail.data) {
    return <div className="p-10 text-center text-sm text-destructive">材料不存在</div>;
  }

  const { material, progress } = detail.data;
  const cues = cuesQuery.data?.cues ?? [];
  const activeCue = activeCueIndex >= 0 ? (cues[activeCueIndex] ?? null) : null;
  const activeJob = jobs.data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');

  return (
    /* 播放页容器：移动单列 / 桌面左右分栏 */
    <div className="mx-auto w-full max-w-6xl px-3 pb-8 pt-3 md:px-8 md:pt-6">
      {/* 面包屑标题 */}
      <header className="mb-3 flex items-baseline gap-2">
        <h1 className="truncate font-serif text-lg md:text-xl">{material.title}</h1>
        <span className="ml-auto shrink-0 text-xs text-ochre">
          {material.sentenceCount ?? '—'} 句 · {material.uniqueWordCount ?? '—'} 词
        </span>
      </header>

      {/* 播放器（sticky：移动端滚动时保持可见） */}
      <div className="sticky top-0 z-20 -mx-3 bg-background/95 px-3 pb-2 pt-1 backdrop-blur md:static md:mx-0 md:bg-transparent md:px-0 md:backdrop-blur-none">
        <Player
          material={material}
          cues={cues}
          initialPositionMs={progress?.lastPositionMs ?? 0}
        />
      </div>

      {/* 字幕未就绪：处理进度面板 */}
      {material.subtitleStatus !== 'ready' ? (
        <ProcessingPanel
          status={material.subtitleStatus}
          job={activeJob ?? null}
          failedJob={jobs.data?.jobs.find((j) => j.status === 'failed') ?? null}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <>
          {/* 标签条（sticky 于播放器下方；横向滚动容纳 5 个标签） */}
          <nav className="deckle sticky top-[calc(env(safe-area-inset-top)+3.4rem)] z-10 -mx-3 mb-2 flex overflow-x-auto border-b bg-background/95 px-3 backdrop-blur md:static md:mx-0 md:px-0">
            {(
              [
                ['current', '当前句'],
                ['bilingual', '双语精读'],
                ['dictation', '听写'],
                ['shadowing', '跟读'],
                ['quiz', '测验'],
              ] as Array<[TabKey, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`relative shrink-0 px-4 py-2.5 text-sm transition-colors ${
                  tab === key ? 'font-medium text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
                {/* 活动下划线：朱砂 */}
                {tab === key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
              </button>
            ))}
          </nav>

          {/* 标签内容 */}
          <div className="min-h-50dvh">
            {tab === 'current' && <CurrentSentenceTab cue={activeCue} materialId={materialId} />}
            {tab === 'bilingual' && <BilingualTab cues={cues} material={material} />}
            {tab === 'dictation' && <DictationTab cues={cues} />}
            {tab === 'shadowing' && <ShadowingTab cues={cues} />}
            {tab === 'quiz' && <QuizTab materialId={materialId} />}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 字幕处理进度面板（导入/重STT/重译进行中或失败）
 */
function ProcessingPanel({
  status,
  job,
  failedJob,
  onRetry,
}: {
  status: string;
  job: JobDTO | null;
  failedJob: JobDTO | null;
  onRetry: () => void;
}) {
  if (status === 'failed' || failedJob) {
    return (
      <div className="deckle mt-6 rounded-md border border-destructive/40 bg-destructive/5 p-6 text-center">
        <p className="font-serif text-base">字幕处理失败</p>
        <p className="mt-2 break-all text-xs text-muted-foreground">{failedJob?.error ?? '未知错误'}</p>
        {/* 重试 = 触发一次 jobs 轮询（惰性恢复会重挂未终态任务）；失败态则走重新 STT */}
        <button
          onClick={() => {
            onRetry();
          }}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          刷新状态
        </button>
      </div>
    );
  }
  return (
    <div className="deckle mt-6 rounded-md border bg-card p-6">
      <div className="flex justify-between text-sm">
        <span>{job?.message ?? '字幕生成排队中…'}</span>
        <span className="tabular-nums">{Math.round((job?.progress ?? 0) * 100)}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{ width: `${Math.max(3, (job?.progress ?? 0) * 100)}%` }}
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        转写与翻译在本地引擎进行，长音频可能需要几分钟；可离开此页，任务会继续。
      </p>
    </div>
  );
}
