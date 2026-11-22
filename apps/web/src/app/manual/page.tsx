'use client';

/**
 * 研习手册页（设计稿 _7 研习手册 Manual —— 词汇深研态）
 *
 * 六区块自上而下：词头（音标 + TTS + SRS 轮转）→ 原典语境（双语句对 +
 * 词高亮 + 去原声）→ 词源构架（复用深学卡）→ 辨析矩阵（AI 近义对比）→
 * 拼字演练（前端逐字母）→ 仿写演练（AI 点拨 + 收入笔记）。
 * 词序 = 复习队列到期序（手账「N / 42 词」意象）；词藏页可指定词进入。
 * 五张卡片均以 key={wordId} 渲染：换词即重挂载，草稿/mutation 状态天然
 * 归零（不靠 reset effect 补救，也防上一词的生成/点拨状态漏进新词）。
 */

import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { api } from '@/lib/api';
import { genLabel, useArtifactGenerate, type WordArtifactPath } from '@/lib/useArtifactGeneration';
import { ttsAudioUrl } from '@/lib/ttsUrl';
import { type Discriminate, type WriteCheck } from '@/lib/manualCard';
import { WRITE_TEXT_MAX } from '@/lib/limits';
import type { DeepCard } from '@/lib/deepCard';
import { escapeRegExp } from '@/lib/regexp';

/** 手册聚合数据形态（GET /api/words/[id]/manual） */
interface ManualData {
  word: {
    id: number;
    lemma: string;
    displayForm: string;
    phoneticUk: string | null;
    phoneticUs: string | null;
    status: string;
    noteMd: string | null;
  };
  srs: { reps: number; stability: number; dueMs: string } | null;
  cue: {
    id: number;
    textEn: string;
    textZh: string | null;
    startMs: number;
    endMs: number;
    materialId: number;
    materialTitle: string;
  } | null;
}

/** 深学卡数据形态（GET /api/words/[id]/deep；词源形态取自服务端 schema 单源） */
type DeepData = { etymology: Omit<DeepCard, 'frames'> | null; frames: DeepCard['frames'] | null };

/** 辨析矩阵数据形态（GET /api/words/[id]/discriminate；矩阵形态取自服务端 schema 单源） */
type MatrixData = { matrix: Discriminate | null };

/** 复习队列形态（导航与统计；只声明本页用到的字段） */
interface QueueResp {
  queue: Array<{ wordId: number; lemma: string }>;
  stats: { dueCount: number };
}

/** 仿写点拨结果形态（响应壳；check 形态取自服务端 schema 单源） */
type WriteCheckResult = { check: WriteCheck };

/** 错误信息提取（网络异常与服务端 { error } 统一为可展示文本） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '生成失败';
}

/**
 * 单次朗读 hook：新播放前中断上一段；卸载时停掉在播朗读并让未到的异步
 * 结果过期（代际计数：连点两次只有最后一次出声；卸载后到达的 URL 直接
 * 丢弃——否则会在页面已离开后创建新 Audio 继续出声且无控件可停）
 * @returns 朗读函数（文本 → TTS 播放）
 */
function useTts() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const genRef = useRef(0);
  useEffect(() => {
    /* 卸载清理（return 的才是 cleanup——写在函数体里会变成挂载时执行）：
       代际 +1 使在途请求全部过期，并停掉在播音频 */
    return () => {
      genRef.current += 1;
      ref.current?.pause();
    };
  }, []);
  return useCallback((text: string) => {
    const gen = ++genRef.current;
    ref.current?.pause();
    void ttsAudioUrl(text).then((url) => {
      if (gen !== genRef.current) return;
      const a = new Audio(url);
      ref.current = a;
      void a.play().catch(() => {});
    });
  }, []);
}

/**
 * 原句中目标词形高亮（词首边界 + 前缀匹配，返回节点数组）
 * @param text 原句
 * @param lemma 词元
 */
function highlightWord(text: string, lemma: string): ReactNode[] {
  return text
    .split(new RegExp(`(\\b${escapeRegExp(lemma)}\\w*\\b)`, 'i'))
    .map((p, i) =>
      i % 2 === 1 ? (
        /* 命中词形：朱砂底高亮 */
        <mark key={i} className="rounded-sm bg-primary/15 px-0.5 font-medium text-primary">
          {p}
        </mark>
      ) : (
        <span key={i}>{p}</span>
      )
    );
}

/**
 * 到期时间的人话描述（已到期 / 今日 / 还需 N 天）
 * @param dueMs ISO 时间串
 */
function dueLabel(dueMs: string): string {
  const days = Math.ceil((new Date(dueMs).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return '已到期';
  if (days === 1) return '今日到期';
  return `还需 ${days} 天`;
}

/** 学习状态的中文徽标文案 */
const STATUS_LABEL: Record<string, string> = {
  new: '新词',
  learning: '研习中',
  review: '轮转中',
  mastered: '已入神',
};

/**
 * 词产物生成 hook（词源卡/辨析矩阵卡同构抽一）：GET 查询自持（各卡门控与
 * 数据形态不同），生成回路（POST force → waitForJob → refetch）走
 * lib/useArtifactGeneration 单源——再添词产物卡不复制第四遍生成回路
 * @param wordId  单词 id
 * @param kind    产物 API 路径段（同时作 queryKey 前缀：'deep' / 'discriminate'）
 * @param hasData 已有产物判定谓词（入参为查询缓存值；按钮文案同判据复用）
 */
function useArtifactGeneration<T>(
  wordId: number,
  kind: WordArtifactPath,
  hasData: (data: T | undefined) => boolean,
) {
  const query = useQuery({
    queryKey: [kind, wordId],
    queryFn: () => api<T>(`/api/words/${wordId}/${kind}`),
  });
  const gen = useArtifactGenerate(wordId, kind, () => hasData(query.data), () => void query.refetch());
  return { query, gen };
}

/**
 * 研习手册页组件
 * @param props.searchParams 查询参数（wordId：从词藏页指定词进入）
 */
export default function ManualPage({
  searchParams,
}: {
  searchParams: Promise<{ wordId?: string }>;
}) {
  const sp = use(searchParams);
  const urlWordId = Number(sp.wordId) || null;
  /* 当前深研词（null=待定：等队列默认词） */
  const [wordId, setWordId] = useState<number | null>(urlWordId);
  const speak = useTts();

  /* 到期队列：词序导航 + 默认词 + 到期统计（gcTime 0：重进页取新队列） */
  const queue = useQuery({
    queryKey: ['manual-queue'],
    queryFn: () => api<QueueResp>('/api/review/queue?limit=20'),
    gcTime: 0,
  });
  const items = useMemo(() => queue.data?.queue ?? [], [queue.data]);

  /* 无 URL 指定词时默认取队首（到期最早的词） */
  useEffect(() => {
    if (wordId === null && items.length > 0) setWordId(items[0]!.wordId);
  }, [wordId, items]);

  /* 手册聚合数据（词头 + 语境 + SRS） */
  const manual = useQuery({
    queryKey: ['manual', wordId],
    queryFn: () => api<ManualData>(`/api/words/${wordId}/manual`),
    enabled: wordId !== null,
  });

  /* 队列内序号（手账「第 N / M 词」；不在队列中显示 — ） */
  const pos = items.findIndex((q) => q.wordId === wordId);

  return (
    /* 页面容器 */
    <div className="mx-auto w-full max-w-2xl px-5 py-6 md:py-10">
      {/* 页头：返回词藏 + 标题 + 手账进度 */}
      <header className="mb-5 flex items-center gap-3">
        {/* 返回词藏的返回键 */}
        <Link
          href="/words"
          aria-label="返回词藏"
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-primary"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        {/* 页标题与手账进度 */}
        <div className="flex-1">
          <h2 className="font-serif text-2xl">研习手册</h2>
          <p className="text-xs text-ochre">
            SRS 记忆轮转 · {queue.data ? `${queue.data.stats.dueCount} 词在轮` : '…'}
            {pos >= 0 && ` · 第 ${pos + 1} / ${items.length} 词`}
          </p>
        </div>
        {/* 上一词 / 下一词导航 */}
        <nav className="flex gap-1" aria-label="词序导航">
          <button
            onClick={() => pos > 0 && setWordId(items[pos - 1]!.wordId)}
            disabled={pos <= 0}
            aria-label="上一词"
            className="flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground disabled:opacity-30"
          >
            <span className="material-symbols-outlined">chevron_left</span>
          </button>
          <button
            onClick={() => pos >= 0 && pos < items.length - 1 && setWordId(items[pos + 1]!.wordId)}
            disabled={pos < 0 || pos >= items.length - 1}
            aria-label="下一词"
            className="flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground disabled:opacity-30"
          >
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        </nav>
      </header>

      {wordId === null ? (
        /* 待定词占位（队列失败/空库/装载中三态在组件内早返回） */
        <QueuePlaceholder queueError={queue.isError ? queue.error : null} queueReady={queue.isSuccess} empty={items.length === 0} />
      ) : manual.isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
      ) : manual.isError || !manual.data ? (
        /* 聚合数据失败（词不存在等）：给出可见错误而非空白 */
        <p className="py-16 text-center text-sm text-destructive">手册装载失败：{errMsg(manual.error)}</p>
      ) : (
        <>
          {/* ===== 词头卡：词条 + 音标朗读 + SRS 轮转 ===== */}
          <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
            {/* 词条行：大字词条 + 状态徽标 */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-serif text-3xl tracking-wide">{manual.data.word.displayForm}</h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {STATUS_LABEL[manual.data.word.status] ?? manual.data.word.status}
              </span>
            </div>
            {/* 音标行：英美双音标 + 各自朗读键 */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {manual.data.word.phoneticUk && (
                <button onClick={() => speak(manual.data.word.displayForm)} className="flex items-center gap-1 hover:text-primary">
                  {/* 英音音标与朗读键 */}
                  <span className="material-symbols-outlined text-base">volume_up</span>
                  英 {manual.data.word.phoneticUk}
                </button>
              )}
              {manual.data.word.phoneticUs && (
                <button onClick={() => speak(manual.data.word.displayForm)} className="flex items-center gap-1 hover:text-primary">
                  {/* 美音音标与朗读键 */}
                  <span className="material-symbols-outlined text-base">volume_up</span>
                  美 {manual.data.word.phoneticUs}
                </button>
              )}
              {/* 无音标时的兜底朗读键 */}
              {!manual.data.word.phoneticUk && !manual.data.word.phoneticUs && (
                <button onClick={() => speak(manual.data.word.displayForm)} className="flex items-center gap-1 hover:text-primary">
                  <span className="material-symbols-outlined text-base">volume_up</span>
                  朗读
                </button>
              )}
            </div>
            {/* SRS 轮转行：复习次数 / 稳定性 / 到期 */}
            <p className="mt-2 text-xs text-ochre">
              {manual.data.srs
                ? `第 ${manual.data.srs.reps} 次轮转 · 稳定性 ${manual.data.srs.stability.toFixed(1)} 天 · ${dueLabel(manual.data.srs.dueMs)}`
                : '尚未建卡（智能复习首答后进入 FSRS 轮转）'}
            </p>
          </section>

          {/* ===== 语境/生成/演练五卡（key=wordId：换词整卡重挂，状态天然归零） ===== */}
          <ContextCueCard key={`cue-${wordId}`} data={manual.data} speak={speak} />
          <EtymologyCard key={`deep-${wordId}`} wordId={wordId} example={manual.data.cue?.textEn ?? null} />
          <DiscriminateCard key={`disc-${wordId}`} wordId={wordId} example={manual.data.cue?.textEn ?? null} />
          <SpellDrillCard
            key={`spell-${wordId}`}
            target={manual.data.word.displayForm}
            sentence={manual.data.cue?.textEn ?? null}
            lemma={manual.data.word.lemma}
            speak={speak}
          />
          <WriteCard
            key={`write-${wordId}`}
            wordId={wordId}
            displayForm={manual.data.word.displayForm}
            noteMd={manual.data.word.noteMd}
          />

          {/* ===== 我的笔记（只读展示；编辑回词藏页） ===== */}
          {manual.data.word.noteMd && (
            <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
              {/* 小节标题 */}
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">手账笔记</h4>
              <MarkdownView source={manual.data.word.noteMd} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 原典语境卡
 * ------------------------------------------------------------------------- */

/**
 * 原典语境卡：收录句段双语对读，目标词朱砂高亮；可朗读句、跳原声定位
 * @param props.data 手册聚合数据（取 cue 与 lemma）
 * @param props.speak 朗读函数
 */
function ContextCueCard({ data, speak }: { data: ManualData; speak: (t: string) => void }) {
  const { cue, word } = data;
  if (!cue) {
    return (
      /* 无原典句卡：收录时未挂句段的兜底提示 */
      <section className="deckle mb-4 rounded-md border border-dashed bg-card/50 px-5 py-4 text-center">
        <p className="text-xs text-muted-foreground">此词收录时未挂原典句段（播放页点词收录可溯源）</p>
      </section>
    );
  }
  return (
    /* 语境卡容器 */
    <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
      {/* 小节标题 + 去原声入口 */}
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">原典语境 · {cue.materialTitle}</h4>
        <Link
          href={`/material/${cue.materialId}?t=${cue.startMs + 1}`}
          className="flex items-center gap-1 text-xs text-ochre hover:text-primary"
        >
          <span className="material-symbols-outlined text-sm">play_circle</span>
          去原声
        </Link>
      </div>
      {/* 英文原句（目标词高亮） */}
      <p className="font-serif text-lg leading-relaxed">{highlightWord(cue.textEn, word.lemma)}</p>
      {/* 中文译文 */}
      {cue.textZh && <p className="mt-1.5 text-sm text-muted-foreground">{cue.textZh}</p>}
      {/* 朗读整句键 */}
      <button
        onClick={() => speak(cue.textEn)}
        className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
      >
        <span className="material-symbols-outlined text-sm">record_voice_over</span>
        朗读原句
      </button>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 词源与构架卡（复用 /api/words/[id]/deep）
 * ------------------------------------------------------------------------- */

/**
 * 词源与构架卡：深学卡数据的简版渲染 + 生成/重生成（生成回路走
 * useArtifactGeneration 共享 hook）
 * @param props.wordId 单词 id
 * @param props.example 原典例句（无语境时提示词可参考）
 */
function EtymologyCard({ wordId, example }: { wordId: number; example: string | null }) {
  /* 已有产物判定（force 与按钮文案同判据） */
  const hasDeep = (d: DeepData | undefined) => Boolean(d?.etymology && d?.frames);
  const { query: deep, gen } = useArtifactGeneration<DeepData>(wordId, 'deep', hasDeep);

  return (
    /* 词源卡容器 */
    <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
      {/* 小节标题 + 生成键 */}
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">词源溯流 · 仿写构架</h4>
        <button
          onClick={() => gen.mutate()}
          disabled={gen.isPending}
          className="flex items-center gap-1 rounded border border-secondary/50 px-2.5 py-1 text-xs text-secondary disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">account_tree</span>
          {genLabel(hasDeep(deep.data), gen.isPending)}
        </button>
      </div>
      {/* 生成失败提示 */}
      {gen.isError && <p className="mb-1.5 text-xs text-destructive">生成失败：{errMsg(gen.error)}</p>}
      {(() => {
        /* 卡体四态早返回（装载中/失败/词源/空态），不嵌套三元 */
        if (deep.isLoading) return <p className="text-xs text-muted-foreground">装载中…</p>;
        if (deep.isError) {
          /* 查询失败 ≠ 尚未生成：如实报错，否则用户会去点一次注定无功的生成 */
          return <p className="text-xs text-destructive">深学数据装载失败：{errMsg(deep.error)}</p>;
        }
        if (!deep.data?.etymology) {
          return (
            <p className="text-xs text-muted-foreground">
              尚未生成（需在设置页配置 LLM 档案{example ? '' : '；无原典例句，生成质量可能略降'}）
            </p>
          );
        }
        return (
        <div className="rounded-md bg-muted/40 p-3 text-xs">
          {/* 词源概述 */}
          <p className="text-sm">{deep.data.etymology.origin}</p>
          {/* 构词成分 */}
          {deep.data.etymology.roots.length > 0 && (
            <div className="mt-2 border-l-2 border-primary/40 pl-3">
              {deep.data.etymology.roots.map((r, i) => (
                <p key={i}>
                  <span className="font-serif font-medium">{r.part}</span>
                  <span className="text-muted-foreground"> — {r.meaning}</span>
                  {r.lang && <span className="ml-1 text-[10px] text-ochre">（{r.lang}）</span>}
                </p>
              ))}
            </div>
          )}
          {/* 同源词 */}
          {deep.data.etymology.related.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {deep.data.etymology.related.map((r, i) => (
                <span key={i} className="rounded-full bg-background px-2 py-0.5" title={r.relation}>
                  {r.word}
                </span>
              ))}
            </div>
          )}
          {/* 仿写构架（下方仿写演练的参考） */}
          {deep.data.frames && deep.data.frames.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <p className="mb-1 text-[11px] text-ochre">仿写构架</p>
              {deep.data.frames.map((f, i) => (
                <p key={i} className="font-serif">
                  {f.pattern}
                  {f.tip && <span className="ml-2 font-sans text-[11px] text-muted-foreground">{f.tip}</span>}
                </p>
              ))}
            </div>
          )}
        </div>
        );
      })()}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 辨析矩阵卡
 * ------------------------------------------------------------------------- */

/**
 * 辨析矩阵卡：近义词侧重对比（AI 生成，kind='discriminate' 产物；生成回路
 * 走 useArtifactGeneration 共享 hook）
 * @param props.wordId 单词 id
 * @param props.example 原典例句（空态提示用）
 */
function DiscriminateCard({ wordId, example }: { wordId: number; example: string | null }) {
  /* 已有产物判定（force 与按钮文案同判据） */
  const hasMatrix = (d: MatrixData | undefined) => Boolean(d?.matrix);
  const { query: matrix, gen } = useArtifactGeneration<MatrixData>(wordId, 'discriminate', hasMatrix);

  return (
    /* 辨析卡容器 */
    <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
      {/* 小节标题 + 生成键 */}
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">文人辨析矩阵</h4>
        <button
          onClick={() => gen.mutate()}
          disabled={gen.isPending}
          className="flex items-center gap-1 rounded border border-secondary/50 px-2.5 py-1 text-xs text-secondary disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">psychology_alt</span>
          {genLabel(hasMatrix(matrix.data), gen.isPending)}
        </button>
      </div>
      {/* 生成失败提示 */}
      {gen.isError && <p className="mb-1.5 text-xs text-destructive">生成失败：{errMsg(gen.error)}</p>}
      {(() => {
        /* 卡体四态早返回（装载中/失败/矩阵/空态），不嵌套三元 */
        if (matrix.isLoading) return <p className="text-xs text-muted-foreground">装载中…</p>;
        if (matrix.isError) {
          /* 查询失败 ≠ 尚未生成：如实报错，否则用户会去点一次注定无功的生成 */
          return <p className="text-xs text-destructive">辨析矩阵装载失败：{errMsg(matrix.error)}</p>;
        }
        if (!matrix.data?.matrix) {
          return (
            <p className="text-xs text-muted-foreground">
              尚未生成（需在设置页配置 LLM 档案{example ? '' : '；无原典例句，生成质量可能略降'}）
            </p>
          );
        }
        return (
        <div>
          {/* 一句意象总评 */}
          <p className="font-serif text-sm italic text-ochre">意象：{matrix.data.matrix.summary}</p>
          {/* 近义对比列表 */}
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {matrix.data.matrix.rivals.map((r, i) => (
              <div key={i} className="min-w-40 flex-1 rounded-md bg-muted/40 p-3 text-xs">
                <p className="font-serif text-sm font-medium">{r.word}</p>
                <p className="mt-1 text-primary">{r.focus}</p>
                <p className="mt-1 text-muted-foreground">{r.nuance}</p>
              </div>
            ))}
          </div>
        </div>
        );
      })()}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 拼字演练卡（纯前端交互，设计稿 _7 词根拼字）
 * ------------------------------------------------------------------------- */

/**
 * 拼字槽位配色：未输灰槽 / 已对竹青 / 已错朱砂
 * @param t 已输字母（undefined=未输到该位）
 * @param c 目标字母
 */
function slotCls(t: string | undefined, c: string): string {
  if (t === undefined) return 'border-border text-muted-foreground';
  if (t === c) return 'border-secondary/60 text-secondary';
  return 'border-destructive/60 text-destructive';
}

/**
 * 首个错位下标（-1=全对或未输完）：槽位配色/「第 N 个字母有误」提示与提示键
 * 修位逻辑共用——各写一份会在调整口径（如忽略大小写）时漂移，提示键修的
 * 位置与文案报的位置对不上
 * @param typed   已键入串（已与字母槽同口径归一为 a-z）
 * @param letters 目标字母序列
 */
function firstWrongIndex(typed: string, letters: string[]): number {
  return typed.split('').findIndex((c, i) => c !== letters[i]);
}

/**
 * 拼字演练卡：目标词逐字母默写（不区分大小写），完成即朗读印证（提示键
 * 补满完成的路径同样朗读——印证文案「已朗读」才永远属实）；有原句时同时
 * 展示挖空句辅助回忆
 * @param props.target 目标词（展示形态）
 * @param props.sentence 原典例句（可空；展示挖空形态）
 * @param props.lemma 词元（原句挖空匹配用）
 * @param props.speak 朗读函数
 */
function SpellDrillCard({
  target,
  sentence,
  lemma,
  speak,
}: {
  target: string;
  sentence: string | null;
  lemma: string;
  speak: (t: string) => void;
}) {
  /* 字母槽与隐藏输入同口径归一（只留 a-z）：含撇号/连字符/重音的词形
     （don't / co-op / café）若按原词形开槽，键入路径永远无法输满 */
  const letters = target.toLowerCase().replace(/[^a-z]/g, '').split('');
  const [typed, setTyped] = useState('');

  /** 首个错位下标（-1=全对或未输完；与提示键共用 firstWrongIndex 单源） */
  const wrongAt = firstWrongIndex(typed, letters);
  /* 归一后无字母（非拉丁词形）不设完成态——0==0 恒真会挂载即朗读 */
  const complete = letters.length > 0 && typed.length === letters.length && wrongAt === -1;

  /* 完成即朗读（跃迁触发：键入补满与提示键补满两条路径统一在此收口） */
  const wasCompleteRef = useRef(false);
  useEffect(() => {
    if (complete && !wasCompleteRef.current) speak(target);
    wasCompleteRef.current = complete;
  }, [complete, speak, target]);

  /** 挖空句（原句中词形替换为等长下划线，辅助回忆） */
  const cloze = sentence
    ? sentence.replace(new RegExp(`\\b(${escapeRegExp(lemma)}\\w*)\\b`, 'i'), (m) => '＿'.repeat(m.length))
    : null;

  return (
    /* 拼字卡容器 */
    <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
      {/* 小节标题 + 操作键组 */}
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">拼字演练 · 逐字母默写</h4>
        <div className="flex gap-2 text-xs">
          {/* 提示键：先修首个错位再补下一字母 */}
          <button
            onClick={() =>
              setTyped((t) => {
                /* 直接在尾部追加会让错位字母永远留在槽里——complete（精确
                   匹配）永不可达，完成朗读不再触发；先截到首个错位处（与
                   槽位提示同口径）再补该位的正确字母 */
                const wrong = firstWrongIndex(t, letters);
                const base = wrong >= 0 ? t.slice(0, wrong) : t;
                return base.length < letters.length ? base + letters[base.length] : t;
              })
            }
            disabled={complete}
            className="rounded border border-border px-2 py-1 text-muted-foreground disabled:opacity-40"
          >
            提示
          </button>
          {/* 重来键 */}
          <button
            onClick={() => setTyped('')}
            className="rounded border border-border px-2 py-1 text-muted-foreground"
          >
            重来
          </button>
          {/* 听音键 */}
          <button onClick={() => speak(target)} className="rounded border border-border px-2 py-1 text-muted-foreground">
            听音
          </button>
        </div>
      </div>
      {/* 挖空原句（回忆线索） */}
      {cloze && cloze.trim() && <p className="mb-2 font-serif text-sm text-muted-foreground">{cloze}</p>}
      {/* 字母槽位行 */}
      <div className="flex flex-wrap gap-1">
        {letters.map((c, i) => {
          /* 槽位配色：已对竹青 / 已错朱砂 / 未输灰槽（slotCls 单源） */
          const cls = slotCls(typed[i], c);
          return (
            <span
              key={i}
              className={`flex size-8 items-center justify-center rounded border font-mono text-sm ${cls}`}
            >
              {typed[i] ?? '·'}
            </span>
          );
        })}
      </div>
      {/* 隐形输入：聚焦整卡即可键入（移动端不必点开键盘浮层） */}
      <input
        value={typed}
        onChange={(e) => {
          const v = e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, letters.length);
          setTyped(v);
        }}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="逐字母默写输入"
        className="mt-2 h-9 w-full rounded border border-input bg-background px-2 font-mono text-sm tracking-[0.3em]"
      />
      {/* 完成印证文案 */}
      {complete && <p className="mt-2 text-xs text-secondary">印证无误 · 已朗读</p>}
      {wrongAt >= 0 && <p className="mt-2 text-xs text-destructive">第 {wrongAt + 1} 个字母有误，改过再续</p>}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 仿写演练卡（设计稿 _7 文人仿写演练场）
 * ------------------------------------------------------------------------- */

/**
 * 仿写演练卡：围绕目标词写一句，AI 即时点拨（总评/亮点待改/搭配建议）；
 * 可把仿写句收入手账笔记。点拨结果与「点拨那一刻的草稿」绑定：草稿改动
 * 即清点拨结果（收入笔记时不会把旧总评配给新句子）
 * @param props.wordId 单词 id
 * @param props.displayForm 目标词（提示文案用）
 * @param props.noteMd 现有笔记（追加收入时保留原文）
 */
function WriteCard({ wordId, displayForm, noteMd }: { wordId: number; displayForm: string; noteMd: string | null }) {
  const [text, setText] = useState('');
  /* 被点拨的草稿快照：点拨请求在途时草稿仍可改，响应落地后只对仍匹配的草稿
     生效（渲染与收入笔记同判据），否则「上一句的点评」会挂到新草稿下 */
  const [submittedText, setSubmittedText] = useState<string | null>(null);
  const qc = useQueryClient();

  /* AI 点拨（同步接口，一次往返） */
  const check = useMutation({
    mutationFn: (draft: string) =>
      api<WriteCheckResult>(`/api/words/${wordId}/write-check`, {
        method: 'POST',
        body: JSON.stringify({ text: draft }),
      }),
    onMutate: (draft) => setSubmittedText(draft),
  });
  const checkCurrent = submittedText !== null && submittedText === text ? check.data : undefined;

  /* 收入笔记：仿写句追加到 noteMd（点拨总评一并留痕）。底稿取查询缓存现值
     而非闭包 props（快照），成功后失效缓存并清草稿——否则连续两次收入时
     第二次仍以旧底拼接整体 PATCH，第一次的追加被静默抹掉 */
  const saveNote = useMutation({
    mutationFn: () => {
      const fresh = qc.getQueryData<ManualData>(['manual', wordId]);
      const base = fresh?.word?.noteMd ?? noteMd;
      /* 本地时区日期戳：toISOString 是 UTC，北京时间 0-8 点保存会盖上昨日戳 */
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const appended = `${base ? base.trimEnd() + '\n\n' : ''}> 仿写（${stamp}）：${text}` + (checkCurrent ? `\n> 点拨：${checkCurrent.check.overall}` : '');
      return api(`/api/words/${wordId}`, { method: 'PATCH', body: JSON.stringify({ noteMd: appended }) });
    },
    onSuccess: () => {
      setText('');
      /* 收纳成功后点拨结果一并清（草稿已清，留着会「空输入+旧总评」同框） */
      check.reset();
      setSubmittedText(null);
      void qc.invalidateQueries({ queryKey: ['manual', wordId] });
    },
  });

  return (
    /* 仿写卡容器 */
    <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
      {/* 小节标题 */}
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">仿写演练 · 将 {displayForm} 付诸笔端</h4>
      {/* 仿写输入区（maxLength 与服务端闸同源：超长不会再被静默截断评分） */}
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          /* 草稿变了，旧点拨结果不再适用于新句子 */
          if (check.data || check.isError) {
            check.reset();
            setSubmittedText(null);
          }
        }}
        maxLength={WRITE_TEXT_MAX}
        placeholder={`写一句包含 ${displayForm} 的话…`}
        className="min-h-20 w-full rounded border border-input bg-background p-2 text-sm"
      />
      {/* 操作行：字数 + AI 点拨键 + 收入笔记键 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          已键入 {text.trim().length} / {WRITE_TEXT_MAX} 字
        </span>
        <button
          onClick={() => check.mutate(text)}
          disabled={!text.trim() || check.isPending}
          className="ml-auto flex items-center gap-1 rounded border border-secondary/50 px-2.5 py-1 text-xs text-secondary disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">auto_awesome</span>
          {check.isPending ? '点拨中…' : 'AI 点拨'}
        </button>
        <button
          onClick={() => saveNote.mutate()}
          disabled={!text.trim() || saveNote.isPending}
          className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs text-muted-foreground disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">bookmark_add</span>
          {saveNote.isPending ? '收纳中…' : '收入笔记'}
        </button>
      </div>
      {/* 点拨失败提示（草稿已改的话连失败态一并失效，不算数） */}
      {check.isError && submittedText === text && (
        <p className="mt-2 text-xs text-destructive">点拨失败：{errMsg(check.error)}</p>
      )}
      {/* 收纳结果反馈 */}
      {saveNote.isSuccess && <p className="mt-2 text-xs text-secondary">已收入手账笔记（词藏页可编辑）</p>}
      {/* 点拨结果：总评 + 逐条点评 + 搭配建议（只对仍匹配的草稿生效） */}
      {checkCurrent && (
        <div className="mt-3 rounded-md bg-muted/40 p-3 text-xs">
          <p className="text-sm">{checkCurrent.check.overall}</p>
          {checkCurrent.check.points.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {checkCurrent.check.points.map((p, i) => (
                <li key={i} className="flex gap-1.5">
                  {/* 点评图标：亮点竹青勾 / 待改朱砂叹 */}
                  <span className={`material-symbols-outlined text-sm ${p.kind === 'good' ? 'text-secondary' : 'text-destructive'}`}>
                    {p.kind === 'good' ? 'check_circle' : 'error'}
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>
          )}
          {checkCurrent.check.collocations.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <p className="mb-1 text-[11px] text-ochre">典雅搭配</p>
              <div className="flex flex-wrap gap-1.5">
                {checkCurrent.check.collocations.map((c, i) => (
                  <span key={i} className="rounded-full bg-background px-2 py-0.5 font-serif">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 待定词占位（队列三态早返回，不嵌套三元）：失败 / 空库引导 / 装载中
 * @param props.queueError 队列查询失败对象（null=未失败）
 * @param props.queueReady 队列查询已成功
 * @param props.empty      队列为空（全库无到期词）
 */
function QueuePlaceholder({
  queueError,
  queueReady,
  empty,
}: {
  queueError: Error | null;
  queueReady: boolean;
  empty: boolean;
}) {
  if (queueError) {
    return <p className="py-16 text-center text-sm text-destructive">复习队列装载失败：{errMsg(queueError)}</p>;
  }
  if (queueReady && empty) {
    return (
      <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
        <p className="font-serif">暂无到期之词</p>
        <p className="mt-1 text-xs text-muted-foreground">
          词藏空空如也 —— 去播放页点词收录，或到{' '}
          <Link href="/review" className="underline underline-offset-2 hover:text-primary">
            智能复习
          </Link>{' '}
          轮转牢记
        </p>
      </div>
    );
  }
  return <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>;
}
