'use client';

/**
 * 演练场页（底部导航「演练」入口）
 *
 * M2 形态：可练习材料的快捷入口（字幕就绪即可听写/跟读/测验）+ 全局错题回顾。
 * SRS 复习枢纽（设计稿 _7）在 M4 交付。
 */

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** 材料行（演练入口用） */
interface PracticeMaterial {
  id: number;
  title: string;
  sourceType: string;
  sentenceCount: number | null;
  mediaDurationMs: number | null;
}

/** 全局错题形态 */
interface GlobalWrong {
  materialId: number;
  type: string;
  questionJson: string;
  userAnswer: string | null;
  createdAt: string;
}

/**
 * 演练场页组件
 */
export default function PracticePage() {
  const [showWrong, setShowWrong] = useState(false);

  /* 全部就绪材料（借材料集接口逐集拉取太繁；M2 简化：最近就绪材料 —— 复用 /api/jobs 不合适，
     这里直接用收藏接口？不 —— 引入轻量列表：借 collections + 首页分页接口逐集拉会多请求。
     实际实现：给演练页一个「最近材料」视图，直接遍历集合接口） */
  const recent = useQuery({
    queryKey: ['practice-materials'],
    queryFn: async () => {
      const cols = await api<{ collections: Array<{ id: number; name: string }> }>('/api/collections');
      const all: Array<PracticeMaterial & { collectionName: string }> = [];
      for (const c of cols.collections.slice(0, 10)) {
        const r = await api<{ materials: PracticeMaterial[] }>(
          `/api/collections/${c.id}/materials?page=1&pageSize=50&status=ready`
        );
        all.push(...r.materials.map((m) => ({ ...m, collectionName: c.name })));
      }
      return all.slice(0, 30);
    },
  });

  /* 全局错题（跨材料）—— 复用 quiz attempt 接口需要按材料查；M2 演练页取最近练习过的材料错题：
     简化为列出最近材料的错题入口（避免新增全局接口） */
  const recentWrong = useQuery({
    queryKey: ['practice-wrong'],
    queryFn: async () => {
      const mats = recent.data ?? [];
      const out: GlobalWrong[] = [];
      for (const m of mats.slice(0, 8)) {
        const r = await api<{ wrong: Array<{ type: string; question: unknown; userAnswer: string | null; createdAt: string }> }>(
          `/api/materials/${m.id}/quiz/attempt`
        );
        out.push(
          ...r.wrong.slice(0, 3).map((w) => ({
            materialId: m.id,
            type: w.type,
            questionJson: JSON.stringify(w.question),
            userAnswer: w.userAnswer,
            createdAt: w.createdAt,
          }))
        );
      }
      return out.slice(0, 10);
    },
    enabled: showWrong && !!recent.data,
  });

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-4xl px-5 py-6 md:px-12 md:py-10">
      <header className="mb-6">
        <h2 className="font-serif text-2xl md:text-3xl">演练场</h2>
        <p className="mt-1 text-sm text-ochre">听写 · 跟读 · 测验 —— 进入材料的练习标签页开始</p>
      </header>

      {/* 智能复习入口（M4：FSRS-6，需求 18） */}
      <ReviewEntry />

      {/* 可练习材料列表 */}
      {recent.isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">装载中…</p>
      ) : (recent.data ?? []).length === 0 ? (
        <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
          <p className="font-serif">暂无可练习的材料</p>
          <p className="mt-1 text-xs text-muted-foreground">导入音视频或文本（字幕就绪后即可演练）</p>
          <Link href="/import" className="mt-4 inline-block rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
            去导入
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {(recent.data ?? []).map((m) => (
            <Link
              key={m.id}
              href={`/material/${m.id}`}
              className="deckle flex items-center gap-3 rounded-md border bg-card px-4 py-3 transition-colors hover:bg-accent/60"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-base">{m.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {m.collectionName} · {m.sentenceCount ?? '—'} 句
                </p>
              </div>
              <span className="material-symbols-outlined text-xl text-ochre">chevron_right</span>
            </Link>
          ))}
        </div>
      )}

      {/* 全局错题入口 */}
      <section className="mt-8">
        <button
          onClick={() => setShowWrong((v) => !v)}
          className="deckle flex w-full items-center justify-between rounded-md border bg-card px-4 py-3 text-sm"
        >
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-primary">history</span>
            最近错题回顾
          </span>
          <span className="material-symbols-outlined text-lg text-muted-foreground">
            {showWrong ? 'expand_less' : 'expand_more'}
          </span>
        </button>
        {showWrong && (
          <div className="mt-2 flex flex-col gap-2">
            {recentWrong.isLoading ? (
              <p className="p-3 text-xs text-muted-foreground">装载中…</p>
            ) : (recentWrong.data ?? []).length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                没有错题记录（先去测验标签页做一套题）
              </p>
            ) : (
              (recentWrong.data ?? []).map((w, i) => {
                const q = JSON.parse(w.questionJson) as { stem?: string; sentence?: string; question?: string };
                return (
                  <Link
                    key={i}
                    href={`/material/${w.materialId}`}
                    className="deckle rounded-md border bg-card p-3 text-xs"
                  >
                    <p className="line-clamp-2">
                      <span className="mr-1 text-ochre">[{w.type === 'choice' ? '选择' : w.type === 'cloze' ? '填空' : '问答'}]</span>
                      {q.stem ?? q.sentence ?? q.question}
                    </p>
                    {w.userAnswer && <p className="mt-1 text-destructive">你的作答：{w.userAnswer === 'self-ok' ? '（未掌握标记）' : w.userAnswer}</p>}
                  </Link>
                );
              })
            )}
          </div>
        )}
      </section>

      <p className="mt-8 text-[11px] text-muted-foreground">SRS 记忆轮转复习将在 M4 里程碑在此就位。</p>
    </div>
  );
}


/** 智能复习入口（到期/新词统计 + 进入复习） */
function ReviewEntry() {
  const stats = useQuery({
    queryKey: ['review-queue-stats'],
    queryFn: () =>
      api<{ stats: { totalWords: number; dueCount: number; newCount: number } }>('/api/review/queue?limit=1'),
  });
  const s = stats.data?.stats;
  return (
    <Link
      href="/review"
      className="deckle mb-6 flex items-center gap-4 rounded-md border bg-card p-4 transition-colors hover:bg-accent/60"
    >
      <span className="material-symbols-outlined text-3xl text-primary">psychology</span>
      <div className="flex-1">
        <p className="font-serif text-base">智能复习 · 记忆轮转</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {s ? `${s.dueCount} 词到期 · ${s.newCount} 新词待记 · 词库 ${s.totalWords}` : 'FSRS-6 调度的多题型训练'}
        </p>
      </div>
      <span className="material-symbols-outlined text-2xl text-ochre">chevron_right</span>
    </Link>
  );
}
