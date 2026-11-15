'use client';

/**
 * 智能复习页（需求 18：多题型训练牢记生词，FSRS-6 调度）
 *
 * 题型按词自适应（种子确定）：
 * - cloze 原句挖空（有原句时）：原句中目标词挖空 → 4 选 1
 * - listen 听音选词：TTS 朗读 → 4 词选 1
 * - meaning 释义选词（有 AI 笔记时）：中文释义 → 4 词选 1
 * 答后四档评分（again/hard/good/easy）→ FSRS 调度 → 下一词。
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { seededShuffle } from '@pinglc/core';
import { api } from '@/lib/api';

/** 队列项 */
interface QueueItem {
  wordId: number;
  lemma: string;
  displayForm: string;
  aiNoteMd: string | null;
  reps: number;
  isNew: boolean;
  cueText: string | null;
}


/** 队列响应 */
interface QueueResp {
  queue: QueueItem[];
  pool: string[];
  stats: { totalWords: number; dueCount: number; newCount: number };
}

/** 正则元字符转义（词条可能含 c++、a.b、(be) 等形态——未转义会抛 SyntaxError 炸整页） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 AI 笔记里抽「释义」首行（粗解析，够用） */
function extractMeaning(aiNote: string | null): string | null {
  if (!aiNote) return null;
  const m = aiNote.match(/##\s*释义\s*\n+([\s\S]*?)(?:\n\n|\n##|$)/);
  if (!m) return null;
  const line = m[1]!.trim().split('\n')[0]!.replace(/^[-*]\s*/, '');
  return line.length > 2 ? line.slice(0, 60) : null;
}

/**
 * 复习页组件
 */
export default function ReviewPage() {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [againList, setAgainList] = useState<string[]>([]);

  const queueQuery = useQuery({ queryKey: ['review-queue'], queryFn: () => api<QueueResp>('/api/review/queue?limit=20') });
  // 本轮快照：session 为空且不在「重启中」时才播种——中途任何 refetch
  // （断线重连等）都不换题；「再来一轮」置重启旗标防旧缓存回灌，待 refetch
  // 返回的新数据显式播种
  const [session, setSession] = useState<QueueItem[] | null>(null);
  const restarting = useRef(false);
  useEffect(() => {
    if (!restarting.current && session === null && queueQuery.data) {
      setSession(queueQuery.data.queue);
    }
  }, [session, queueQuery.data]);
  const items = session ?? [];
  // 池引用稳定化（每次渲染 ?? [] 产生新数组，会抖动 useMemo 依赖）
  const pool = useMemo(() => queueQuery.data?.pool ?? [], [queueQuery.data]);
  const item = items[index];

  /** 本词题型（种子确定）：优先级 cloze > listen > meaning，按词与轮次散列 */
  const drill = useMemo(() => {
    if (!item) return null as null | { type: 'cloze' | 'listen' | 'meaning'; options: string[]; stem: string };
    const meaning = extractMeaning(item.aiNoteMd);
    const types: Array<'cloze' | 'listen' | 'meaning'> = [];
    if (item.cueText && new RegExp(`\\b${escapeRegExp(item.lemma)}\\w*\\b`, 'i').test(item.cueText)) types.push('cloze');
    types.push('listen');
    if (meaning) types.push('meaning');
    const type = types[done % types.length]!;
    // 干扰项：池中随机 3 个（去重、排除同词）
    const distractors = seededShuffle(
      pool.filter((p) => p !== item.lemma),
      `${item.wordId}-${done}`
    ).slice(0, 3);
    const options = seededShuffle([item.lemma, ...distractors], `${item.wordId}-opt-${done}`);
    const stem =
      type === 'cloze'
        ? item.cueText!.replace(new RegExp(`\\b(${escapeRegExp(item.lemma)}\\w*)\\b`, 'i'), '＿＿＿')
        : type === 'meaning'
          ? meaning!
          : '';
    return { type, options, stem };
  }, [item, done, pool]);

  /** 评分提交 */
  const answer = useMutation({
    mutationFn: (rating: 'again' | 'hard' | 'good' | 'easy') =>
      api<{ scheduledDays: number }>(`/api/review/answer`, {
        method: 'POST',
        body: JSON.stringify({ wordId: item!.wordId, rating }),
      }),
    onSuccess: (r, rating) => {
      if (rating === 'again') setAgainList((prev) => [...prev, item!.displayForm]);
      setDone((d) => d + 1);
      setPicked(null);
      setIndex((i) => i + 1);
    },
  });


  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-2xl px-5 py-6 md:py-10">
      <header className="mb-5 flex items-center gap-3">
        <Link href="/words" aria-label="返回词藏" className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-primary">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <div className="flex-1">
          <h2 className="font-serif text-2xl">智能复习</h2>
          <p className="text-xs text-ochre">FSRS-6 调度 · {queueQuery.data?.stats.dueCount ?? 0} 词到期</p>
        </div>
        <span className="text-xs text-muted-foreground">
          {Math.min(index, items.length)} / {items.length}
        </span>
      </header>

      {queueQuery.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : queueQuery.isFetching && session === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">取题中…</p>
      ) : queueQuery.isSuccess && session !== null && items.length === 0 ? (
        <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
          <span className="material-symbols-outlined mb-2 text-4xl text-secondary">task_alt</span>
          <p className="font-serif text-lg">今日无待复习</p>
          <p className="mt-1 text-xs text-muted-foreground">新收录的生词会立即进入队列；去播放页点词收藏吧。</p>
          <Link href="/" className="mt-4 inline-block rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
            去精读
          </Link>
        </div>
      ) : queueQuery.isSuccess && session !== null && index >= items.length && items.length > 0 ? (
        /* 本轮结算 */
        <div className="deckle flex flex-col items-center rounded-md border bg-card px-6 py-12 text-center">
          <span className="material-symbols-outlined mb-2 text-4xl text-secondary">military_tech</span>
          <p className="font-serif text-2xl">本轮完成</p>
          <p className="mt-2 text-sm text-muted-foreground">
            复习 {done} 词{againList.length > 0 ? `，其中 ${againList.length} 词标记「再记」` : ''}
          </p>
          {againList.length > 0 && <p className="mt-1 text-xs text-destructive">{againList.join(' · ')}</p>}
          <div className="mt-5 flex gap-3">
            <button
              onClick={async () => {
                setIndex(0);
                setDone(0);
                setAgainList([]);
                restarting.current = true; // 阻断 effect 用旧缓存回灌
                setSession(null);
                try {
                  const fresh = await queueQuery.refetch();
                  if (fresh.data) setSession(fresh.data.queue);
                } catch {
                  // refetch 失败：回退旧缓存快照（可再战一轮），不白屏
                  if (queueQuery.data) setSession(queueQuery.data.queue);
                } finally {
                  restarting.current = false;
                }
              }}
              className="rounded-md border border-border px-5 py-2 text-sm"
            >
              再来一轮
            </button>
            <Link href="/words" className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
              回词藏
            </Link>
          </div>
        </div>
      ) : item && drill ? (
        /* 单词卡 */
        <div className="flex flex-col gap-4">
          {/* 新词/复习标记 */}
          <span className={`self-start rounded-full px-2.5 py-0.5 text-[11px] ${item.isNew ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
            {item.isNew ? '新词' : `第 ${item.reps + 1} 次复习`}
          </span>

          {/* 题干 */}
          {drill.type === 'cloze' && (
            <div className="deckle rounded-md border bg-card p-5">
              <p className="mb-2 text-xs text-ochre">原句挖空 —— 选出空缺的词</p>
              <p className="font-serif text-lg leading-relaxed">{drill.stem}</p>
            </div>
          )}
          {drill.type === 'listen' && (
            <div className="deckle flex flex-col items-center rounded-md border bg-card p-6">
              <p className="mb-3 text-xs text-ochre">听音辨词 —— 选出你听到的词</p>
              <button
                onClick={() => {
                  const a = new Audio(`/api/media/tts?text=${encodeURIComponent(item.displayForm)}`);
                  void a.play().catch(() => undefined);
                }}
                className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground"
                aria-label="播放单词读音"
              >
                <span className="material-symbols-outlined text-3xl">volume_up</span>
              </button>
              <p className="mt-2 text-[11px] text-muted-foreground">可反复听</p>
            </div>
          )}
          {drill.type === 'meaning' && (
            <div className="deckle rounded-md border bg-card p-5">
              <p className="mb-2 text-xs text-ochre">释义辨词 —— 哪个词符合此义</p>
              <p className="text-base">{drill.stem}</p>
            </div>
          )}

          {/* 选项 */}
          <div className="grid grid-cols-2 gap-2">
            {drill.options.map((opt) => {
              const isRight = opt === item.lemma;
              const state = picked === null ? 'idle' : opt === picked ? (isRight ? 'right' : 'wrong') : isRight ? 'right' : 'idle';
              return (
                <button
                  key={opt}
                  disabled={picked !== null}
                  onClick={() => setPicked(opt)}
                  className={`deckle rounded-md border py-3 font-serif text-base transition-colors ${
                    state === 'right'
                      ? 'border-secondary bg-secondary/10 text-secondary'
                      : state === 'wrong'
                        ? 'border-destructive bg-destructive/5 text-destructive'
                        : 'border-border bg-card hover:bg-accent'
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>

          {/* 评分（选择后出现；需求 18：按记忆程度四档） */}
          {picked !== null && (
            <div className="flex flex-col gap-2">
              <p className="text-center text-xs text-muted-foreground">
                {picked === item.lemma ? '✓ 正确' : `× 正确答案：${item.lemma}`} —— 你的记忆程度？
              </p>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    ['again', '忘了', 'bg-destructive'],
                    ['hard', '困难', 'border border-ochre/50 text-ochre'],
                    ['good', '记得', 'border border-secondary/60 text-secondary'],
                    ['easy', '轻松', 'border border-border'],
                  ] as Array<[string, string, string]>
                ).map(([rating, label, cls]) => (
                  <button
                    key={rating}
                    onClick={() => answer.mutate(rating as 'again')}
                    disabled={answer.isPending}
                    className={`rounded-md py-2.5 text-sm text-primary-foreground ${cls} disabled:opacity-50`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
