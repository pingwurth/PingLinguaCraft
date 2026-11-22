'use client';

/**
 * 研习手册页（设计稿 _7 研习手册 Manual —— 词汇深研态）
 *
 * 六区块自上而下：词头（音标 + TTS + SRS 轮转）→ 原典语境（双语句对 +
 * 词高亮 + 去原声）→ 词源构架（复用深学卡）→ 辨析矩阵（AI 近义对比）→
 * 拼字演练（前端逐字母）→ 仿写演练（AI 点拨 + 收入笔记）。
 * 词序 = 复习队列到期序（手账「N / 42 词」意象）；词藏页可指定词进入。
 */

import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { api } from '@/lib/api';
import { waitForJob } from '@/lib/jobs/wait';
import { ttsAudioUrl } from '@/lib/ttsUrl';

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
  srs: { reps: number; stability: number; difficulty: number; dueMs: string } | null;
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

/** 深学卡数据形态（GET /api/words/[id]/deep） */
interface DeepData {
  etymology: {
    origin: string;
    roots: Array<{ part: string; meaning: string; lang?: string }>;
    related: Array<{ word: string; relation: string }>;
  } | null;
  frames: Array<{ pattern: string; tip?: string }> | null;
}

/** 辨析矩阵数据形态（GET /api/words/[id]/discriminate） */
interface MatrixData {
  matrix: { summary: string; rivals: Array<{ word: string; focus: string; nuance: string }> } | null;
}

/** 复习队列形态（导航与统计；只声明本页用到的字段） */
interface QueueResp {
  queue: Array<{ wordId: number; lemma: string }>;
  stats: { dueCount: number };
}

/** 仿写点拨结果形态 */
interface WriteCheckResult {
  check: {
    overall: string;
    points: Array<{ kind: 'good' | 'issue'; text: string }>;
    collocations: string[];
  };
}

/** 错误信息提取（网络异常与服务端 { error } 统一为可展示文本） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '生成失败';
}

/** 正则元字符转义（词高亮用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单次朗读 hook：新播放前中断上一段，避免多次点击音频叠加；卸载时停掉
 * 在播朗读（否则离开手册页后音频继续出声且无控件可停）
 * @returns 朗读函数（文本 → TTS 播放）
 */
function useTts() {
  const ref = useRef<HTMLAudioElement | null>(null);
  /* 卸载清理：暂停残留音频 */
  useEffect(() => () => ref.current?.pause(), []);
  return useCallback((text: string) => {
    ref.current?.pause();
    void ttsAudioUrl(text).then((url) => {
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
    enabled: wordId != null,
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
        /* 空态：全库无词可研 */
        queue.isSuccess && items.length === 0 ? (
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
        ) : (
          /* 队列装载中 */
          <p className="py-16 text-center text-sm text-muted-foreground">装载中…</p>
        )
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

          {/* ===== 原典语境卡：收录句对 + 词高亮 + 去原声 ===== */}
          <ContextCueCard data={manual.data} speak={speak} />

          {/* ===== 词源与构架卡（复用深学卡数据与生成链路） ===== */}
          <EtymologyCard wordId={wordId} example={manual.data.cue?.textEn ?? null} />

          {/* ===== 辨析矩阵卡：近义词侧重对比（AI） ===== */}
          <DiscriminateCard wordId={wordId} example={manual.data.cue?.textEn ?? null} />

          {/* ===== 拼字演练卡：逐字母默写 ===== */}
          <SpellDrillCard
            target={manual.data.word.displayForm}
            sentence={manual.data.cue?.textEn ?? null}
            lemma={manual.data.word.lemma}
            speak={speak}
          />

          {/* ===== 仿写演练卡：短句仿写 + AI 点拨 ===== */}
          <WriteCard wordId={wordId} displayForm={manual.data.word.displayForm} noteMd={manual.data.word.noteMd} />

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
 * 词源与构架卡：深学卡数据的简版渲染 + 生成/重生成
 * @param props.wordId 单词 id
 * @param props.example 原典例句（无语境时提示词可参考）
 */
function EtymologyCard({ wordId, example }: { wordId: number; example: string | null }) {
  const deep = useQuery({
    queryKey: ['deep', wordId],
    queryFn: () => api<DeepData>(`/api/words/${wordId}/deep`),
  });
  const gen = useMutation({
    mutationFn: async () => {
      const r = await api<{ cached?: boolean; jobId?: string }>(`/api/words/${wordId}/deep`, {
        method: 'POST',
        // force 与已有数据绑定：按钮文案为「重新生成」时必须真重生成
        body: JSON.stringify({ force: Boolean(deep.data?.etymology && deep.data?.frames) }),
      });
      if (r.cached || !r.jobId) return;
      await waitForJob(r.jobId);
    },
    onSuccess: () => void deep.refetch(),
  });

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
          {deep.data?.etymology && deep.data?.frames ? '重新生成' : gen.isPending ? '生成中…' : '生成'}
        </button>
      </div>
      {/* 生成失败提示 */}
      {gen.isError && <p className="mb-1.5 text-xs text-destructive">生成失败：{errMsg(gen.error)}</p>}
      {deep.isLoading ? (
        <p className="text-xs text-muted-foreground">装载中…</p>
      ) : deep.data?.etymology ? (
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
      ) : (
        <p className="text-xs text-muted-foreground">
          尚未生成（需在设置页配置 LLM 档案{example ? '' : '；无原典例句，生成质量可能略降'}）
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 辨析矩阵卡
 * ------------------------------------------------------------------------- */

/**
 * 辨析矩阵卡：近义词侧重对比（AI 生成，kind='discriminate' 产物）
 * @param props.wordId 单词 id
 * @param props.example 原典例句（空态提示用）
 */
function DiscriminateCard({ wordId, example }: { wordId: number; example: string | null }) {
  const matrix = useQuery({
    queryKey: ['discriminate', wordId],
    queryFn: () => api<MatrixData>(`/api/words/${wordId}/discriminate`),
  });
  const gen = useMutation({
    mutationFn: async () => {
      const r = await api<{ cached?: boolean; jobId?: string }>(`/api/words/${wordId}/discriminate`, {
        method: 'POST',
        // force 与已有数据绑定（同深学卡语义）
        body: JSON.stringify({ force: Boolean(matrix.data?.matrix) }),
      });
      if (r.cached || !r.jobId) return;
      await waitForJob(r.jobId);
    },
    onSuccess: () => void matrix.refetch(),
  });

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
          {matrix.data?.matrix ? '重新生成' : gen.isPending ? '生成中…' : '生成'}
        </button>
      </div>
      {/* 生成失败提示 */}
      {gen.isError && <p className="mb-1.5 text-xs text-destructive">生成失败：{errMsg(gen.error)}</p>}
      {matrix.isLoading ? (
        <p className="text-xs text-muted-foreground">装载中…</p>
      ) : matrix.data?.matrix ? (
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
      ) : (
        <p className="text-xs text-muted-foreground">
          尚未生成（需在设置页配置 LLM 档案{example ? '' : '；无原典例句，生成质量可能略降'}）
        </p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 拼字演练卡（纯前端交互，设计稿 _7 词根拼字）
 * ------------------------------------------------------------------------- */

/**
 * 拼字演练卡：目标词逐字母默写（不区分大小写），完成即朗读印证；
 * 有原句时同时展示挖空句辅助回忆
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
  /* 换词重置（含从队列导航切词） */
  useEffect(() => setTyped(''), [target]);

  /** 首个错位下标（-1=全对或未输完） */
  const wrongAt = typed.split('').findIndex((c, i) => c !== letters[i]);
  const complete = typed.length === letters.length && wrongAt === -1;

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
          {/* 提示键：补出下一正确字母 */}
          <button
            onClick={() => setTyped((t) => (t.length < letters.length ? t + letters[t.length] : t))}
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
          const t = typed[i];
          /* 槽位配色：已对竹青 / 已错朱砂 / 未输灰槽 */
          const cls = t == null ? 'border-border text-muted-foreground' : t === c ? 'border-secondary/60 text-secondary' : 'border-destructive/60 text-destructive';
          return (
            <span
              key={i}
              className={`flex size-8 items-center justify-center rounded border font-mono text-sm ${cls}`}
            >
              {t ?? '·'}
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
          /* 输满且全对：自动朗读印证 */
          if (v.length === letters.length && v.split('').every((c, i) => c === letters[i])) speak(target);
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
 * 可把仿写句收入手账笔记
 * @param props.wordId 单词 id
 * @param props.displayForm 目标词（提示文案用）
 * @param props.noteMd 现有笔记（追加收入时保留原文）
 */
function WriteCard({ wordId, displayForm, noteMd }: { wordId: number; displayForm: string; noteMd: string | null }) {
  const [text, setText] = useState('');
  const qc = useQueryClient();

  /* AI 点拨（同步接口，一次往返） */
  const check = useMutation({
    mutationFn: () =>
      api<WriteCheckResult>(`/api/words/${wordId}/write-check`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  });

  /* 收入笔记：仿写句追加到 noteMd（点拨总评一并留痕）。底稿取查询缓存现值
     而非闭包 props（快照），成功后失效缓存——否则连续两次收入时第二次仍以
     旧底拼接整体 PATCH，第一次的追加被静默抹掉 */
  const saveNote = useMutation({
    mutationFn: () => {
      const fresh = qc.getQueryData<ManualData>(['manual', wordId]);
      const base = fresh?.word?.noteMd ?? noteMd;
      const stamp = new Date().toISOString().slice(0, 10);
      const appended = `${base ? base.trimEnd() + '\n\n' : ''}> 仿写（${stamp}）：${text}` + (check.data ? `\n> 点拨：${check.data.check.overall}` : '');
      return api(`/api/words/${wordId}`, { method: 'PATCH', body: JSON.stringify({ noteMd: appended }) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['manual', wordId] });
    },
  });

  /* 换词重置（含队列导航切词）：草稿之外，点拨/收纳两个 mutation 状态也须清，
     否则上一词的点拨结果残留显示、且新词「收入笔记」会把旧词总评写进新词笔记 */
  const prevWordRef = useRef(wordId);
  useEffect(() => {
    if (prevWordRef.current !== wordId) {
      prevWordRef.current = wordId;
      setText('');
      check.reset();
      saveNote.reset();
    }
  }, [wordId, check, saveNote]);

  return (
    /* 仿写卡容器 */
    <section className="deckle mb-4 rounded-md border bg-card px-5 py-4">
      {/* 小节标题 */}
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">仿写演练 · 将 {displayForm} 付诸笔端</h4>
      {/* 仿写输入区 */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`写一句包含 ${displayForm} 的话…`}
        className="min-h-20 w-full rounded border border-input bg-background p-2 text-sm"
      />
      {/* 操作行：字数 + AI 点拨键 + 收入笔记键 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">已键入 {text.trim().length} 字</span>
        <button
          onClick={() => check.mutate()}
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
      {/* 点拨失败提示 */}
      {check.isError && <p className="mt-2 text-xs text-destructive">点拨失败：{errMsg(check.error)}</p>}
      {/* 收纳结果反馈 */}
      {saveNote.isSuccess && <p className="mt-2 text-xs text-secondary">已收入手账笔记（词藏页可编辑）</p>}
      {/* 点拨结果：总评 + 逐条点评 + 搭配建议 */}
      {check.data && (
        <div className="mt-3 rounded-md bg-muted/40 p-3 text-xs">
          <p className="text-sm">{check.data.check.overall}</p>
          {check.data.check.points.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {check.data.check.points.map((p, i) => (
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
          {check.data.check.collocations.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <p className="mb-1 text-[11px] text-ochre">典雅搭配</p>
              <div className="flex flex-wrap gap-1.5">
                {check.data.check.collocations.map((c, i) => (
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
