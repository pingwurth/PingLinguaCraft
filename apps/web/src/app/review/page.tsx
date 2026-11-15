'use client';

/**
 * 智能复习页（需求 18：多题型训练牢记生词，FSRS-6 调度）
 *
 * 题型按词自适应（种子确定）：
 * - cloze 原句挖空（有原句时）：原句中目标词挖空 → 4 选 1
 * - listen 听音选词：TTS 朗读 → 4 词选 1
 * - meaning 释义选词（有 AI 笔记时）：中文释义 → 4 词选 1
 * 答后四档评分（again/hard/good/easy）→ FSRS 调度 → 下一词。
 * 「忘了」的词 FSRS 会排到明天（当日不再调度），当日内由「再练遗忘词」
 * 重学一轮——纯本地重看，不写 FSRS 状态。
 */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { seededPick, seededShuffle, type SRating } from '@pinglc/core';
import { api } from '@/lib/api';

/** 队列项（与 /api/review/queue 响应契约一致） */
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

/** 错误信息提取（网络异常与服务端 { error } 统一为可展示文本） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '请求失败';
}

/**
 * 复习页组件
 */
export default function ReviewPage() {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  /** 本轮标记「忘了」的词（结算后可「再练遗忘词」） */
  const [againItems, setAgainItems] = useState<QueueItem[]>([]);
  /** 再练轮队列（null=普通轮；再练轮不写 FSRS，只本地重看） */
  const [relearnItems, setRelearnItems] = useState<QueueItem[] | null>(null);

  // gcTime 0：离开页面即弃缓存——重新进入必取新队列，杜绝把上轮旧快照
  // （刚复习完的词已被推到未来）再次播种成题
  const queueQuery = useQuery({
    queryKey: ['review-queue'],
    queryFn: () => api<QueueResp>('/api/review/queue?limit=20'),
    gcTime: 0,
  });
  // 本轮快照：session 为空且不在「重启中」时才播种——中途任何 refetch
  // （断线重连等）都不换题也不换干扰池（pool 随机抽样后若中途 refetch 换池，
  // 当前题的选项会被整组换掉、与已选 picked 错位）；「再来一轮」置重启旗标
  // 防旧缓存回灌，待 refetch 返回的新数据显式播种
  const [session, setSession] = useState<{ items: QueueItem[]; pool: string[] } | null>(null);
  const restarting = useRef(false);
  useEffect(() => {
    if (!restarting.current && session === null && queueQuery.data) {
      setSession({ items: queueQuery.data.queue, pool: queueQuery.data.pool });
    }
  }, [session, queueQuery.data]);
  const items = relearnItems ?? session?.items ?? [];
  // 池引用稳定化（快照后不变；?? [] 的空数组需 memo，防抖动 drill 依赖）
  const pool = useMemo(() => session?.pool ?? [], [session]);
  const item = items[index];

  /** 本词题型（种子确定）：优先级 cloze > listen > meaning，按词与轮次散列 */
  const drill = useMemo(() => {
    if (!item) return null as null | { type: 'cloze' | 'listen' | 'meaning'; options: string[]; stem: string };
    const meaning = extractMeaning(item.aiNoteMd);
    const types: Array<'cloze' | 'listen' | 'meaning'> = [];
    if (item.cueText && new RegExp(`\\b${escapeRegExp(item.lemma)}\\w*\\b`, 'i').test(item.cueText)) types.push('cloze');
    types.push('listen');
    if (meaning) types.push('meaning');
    const type = types[index % types.length]!;
    // 干扰项：池中种子采样 3 个（排除同词；seededPick 只做 3 次交换，
    // 不必整池洗牌 200 词）
    const distractors = seededPick(
      pool.filter((p) => p !== item.lemma),
      3,
      `${item.wordId}-${index}`
    );
    const options = seededShuffle([item.lemma, ...distractors], `${item.wordId}-opt-${index}`);
    const stem =
      type === 'cloze'
        ? item.cueText!.replace(new RegExp(`\\b(${escapeRegExp(item.lemma)}\\w*)\\b`, 'i'), '＿＿＿')
        : type === 'meaning'
          ? meaning!
          : '';
    return { type, options, stem };
  }, [item, index, pool]);

  /** 评分提交（仅普通轮；再练轮不写 FSRS） */
  const answer = useMutation({
    mutationFn: (rating: SRating) =>
      api<{ scheduledDays: number }>(`/api/review/answer`, {
        method: 'POST',
        body: JSON.stringify({ wordId: item!.wordId, rating }),
      }),
    onSuccess: (_r, rating) => {
      if (rating === 'again') setAgainItems((prev) => [...prev, item!]);
      setPicked(null);
      setIndex((i) => i + 1);
    },
    // 失败静默是复习闭环核心写路径的大忌：isError 置位后卡片停在原处并提示
  });

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-2xl px-5 py-6 md:py-10">
      <header className="mb-5 flex items-center gap-3">
        {/* 返回词藏的返回键 */}
        <Link href="/words" aria-label="返回词藏" className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-primary">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        {/* 页标题与到期统计 */}
        <div className="flex-1">
          <h2 className="font-serif text-2xl">智能复习</h2>
          <p className="text-xs text-ochre">FSRS-6 调度 · {queueQuery.data?.stats.dueCount ?? 0} 词到期</p>
        </div>
        {/* 进度计数 */}
        <span className="text-xs text-muted-foreground">
          {Math.min(index, items.length)} / {items.length}
        </span>
      </header>

      {queueQuery.isLoading ? (
        /* 首次装载中 */
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : queueQuery.isError && session === null ? (
        /* 队列拉取失败且无快照可用：给出提示与重试入口（而非渲染空页）；
           已有本轮快照时后台 refetch 的瞬时失败不打断答题 */
        <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
          <span className="material-symbols-outlined mb-2 text-4xl text-destructive">cloud_off</span>
          <p className="font-serif text-lg">取题失败</p>
          <p className="mt-1 text-xs text-muted-foreground">{errMsg(queueQuery.error)}</p>
          <button onClick={() => void queueQuery.refetch()} className="mt-4 rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
            重试
          </button>
        </div>
      ) : queueQuery.isFetching && session === null ? (
        /* 缓存弃用后的重新取题 */
        <p className="py-16 text-center text-sm text-muted-foreground">取题中…</p>
      ) : session !== null && items.length === 0 ? (
        /* 今日无待复习 */
        <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
          <span className="material-symbols-outlined mb-2 text-4xl text-secondary">task_alt</span>
          <p className="font-serif text-lg">今日无待复习</p>
          <p className="mt-1 text-xs text-muted-foreground">新收录的生词会立即进入队列；去播放页点词收藏吧。</p>
          <Link href="/" className="mt-4 inline-block rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
            去精读
          </Link>
        </div>
      ) : session !== null && index >= items.length && items.length > 0 ? (
        /* 本轮结算（普通轮含「再练遗忘词」；再练轮收尾） */
        <div className="deckle flex flex-col items-center rounded-md border bg-card px-6 py-12 text-center">
          <span className="material-symbols-outlined mb-2 text-4xl text-secondary">military_tech</span>
          <p className="font-serif text-2xl">{relearnItems !== null ? '再练完成' : '本轮完成'}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            复习 {items.length} 词{relearnItems === null && againItems.length > 0 ? `，其中 ${againItems.length} 词标记「再记」` : ''}
          </p>
          {relearnItems === null && againItems.length > 0 && <p className="mt-1 text-xs text-destructive">{againItems.map((a) => a.displayForm).join(' · ')}</p>}
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {/* 再练遗忘词：同日重看一轮（不写 FSRS） */}
            {relearnItems === null && againItems.length > 0 && (
              <button
                onClick={() => {
                  setIndex(0);
                  setPicked(null);
                  setRelearnItems(againItems);
                }}
                className="rounded-md border border-ochre/50 px-5 py-2 text-sm text-ochre"
              >
                再练遗忘词（{againItems.length}）
              </button>
            )}
            {/* 再来一轮：弃快照重取队列 */}
            <button
              onClick={async () => {
                setIndex(0);
                setPicked(null);
                setAgainItems([]);
                setRelearnItems(null);
                restarting.current = true; // 阻断 effect 用旧缓存回灌
                setSession(null);
                try {
                  // v5 refetch 失败不 reject（结果带 isError），此处按结果状态判定：
                  // 失败时 fresh.data 即上一份快照——回退旧队列可再战一轮，不白屏
                  const fresh = await queueQuery.refetch();
                  if (fresh.data) setSession({ items: fresh.data.queue, pool: fresh.data.pool });
                  else if (queueQuery.data) setSession({ items: queueQuery.data.queue, pool: queueQuery.data.pool });
                } finally {
                  restarting.current = false;
                }
              }}
              className="rounded-md border border-border px-5 py-2 text-sm"
            >
              再来一轮
            </button>
            {/* 返回词藏 */}
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

          {/* 题干：原句挖空 */}
          {drill.type === 'cloze' && (
            <div className="deckle rounded-md border bg-card p-5">
              <p className="mb-2 text-xs text-ochre">原句挖空 —— 选出空缺的词</p>
              <p className="font-serif text-lg leading-relaxed">{drill.stem}</p>
            </div>
          )}
          {/* 题干：听音辨词 */}
          {drill.type === 'listen' && (
            <div className="deckle flex flex-col items-center rounded-md border bg-card p-6">
              <p className="mb-3 text-xs text-ochre">听音辨词 —— 选出你听到的词</p>
              {/* TTS 播放按钮 */}
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
          {/* 题干：释义辨词 */}
          {drill.type === 'meaning' && (
            <div className="deckle rounded-md border bg-card p-5">
              <p className="mb-2 text-xs text-ochre">释义辨词 —— 哪个词符合此义</p>
              <p className="text-base">{drill.stem}</p>
            </div>
          )}

          {/* 选项（4 选 1） */}
          <div className="grid grid-cols-2 gap-2">
            {drill.options.map((opt) => {
              const isRight = opt === item.lemma;
              const state = picked === null ? 'idle' : opt === picked ? (isRight ? 'right' : 'wrong') : isRight ? 'right' : 'idle';
              return (
                /* 单个选项按钮：作答后着色反馈 */
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

          {/* 作答反馈与评分（选择后出现；再练轮只「继续」不评分） */}
          {picked !== null && (
            <div className="flex flex-col gap-2">
              {/* 对错反馈行 */}
              <p className="text-center text-xs text-muted-foreground">
                {picked === item.lemma ? '✓ 正确' : `× 正确答案：${item.lemma}`}
                {relearnItems === null ? ' —— 你的记忆程度？' : ''}
              </p>
              {relearnItems !== null ? (
                /* 再练轮：继续下一词（不写 FSRS） */
                <button
                  onClick={() => {
                    setPicked(null);
                    setIndex((i) => i + 1);
                  }}
                  className="rounded-md bg-primary py-2.5 text-sm text-primary-foreground"
                >
                  继续
                </button>
              ) : (
                /* 四档评分（需求 18：按记忆程度） */
                <div className="grid grid-cols-4 gap-2">
                  {(
                    [
                      ['again', '忘了', 'bg-destructive'],
                      ['hard', '困难', 'border border-ochre/50 text-ochre'],
                      ['good', '记得', 'border border-secondary/60 text-secondary'],
                      ['easy', '轻松', 'border border-border'],
                    ] as Array<[SRating, string, string]>
                  ).map(([rating, label, cls]) => (
                    /* 单个评分按钮 */
                    <button
                      key={rating}
                      onClick={() => answer.mutate(rating)}
                      disabled={answer.isPending}
                      className={`rounded-md py-2.5 text-sm text-primary-foreground ${cls} disabled:opacity-50`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {/* 评分提交失败提示（卡片停在原处，可直接重点） */}
              {answer.isError && <p className="text-center text-xs text-destructive">提交失败：{errMsg(answer.error)}，答案尚未记录，请重试</p>}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
