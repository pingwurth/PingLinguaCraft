'use client';

/**
 * 词藏页（需求 14：多个生词本、笔记 Markdown 编辑+预览、AI 自动生成单词笔记）
 *
 * 左右布局（移动上下）：词本列表 + 当前词本词表；
 * 词项展开：显示/编辑笔记、AI 笔记生成与查看。
 */

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { api } from '@/lib/api';
import { waitForJob } from '@/lib/jobs/wait';

/** 错误信息提取（网络异常与服务端 { error } 统一为可展示文本） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : '生成失败';
}

/** 词本形态 */
interface BookDTO {
  id: number;
  name: string;
  description: string | null;
  wordCount: number;
}

/** 单词形态 */
interface WordDTO {
  id: number;
  lemma: string;
  displayForm: string;
  noteMd: string | null;
  aiNoteMd: string | null;
  aiNoteStatus: 'none' | 'pending' | 'ready' | 'failed';
  status: string;
  originCueId: number | null;
}

/**
 * 词藏页组件
 */
export default function WordsPage() {
    const [activeBook, setActiveBook] = useState<number | null>(null);
  const [newBook, setNewBook] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  /* 词本列表 */
  const books = useQuery({
    queryKey: ['word-books'],
    queryFn: () => api<{ books: BookDTO[] }>('/api/word-books'),
  });
  const bookList = books.data?.books ?? [];
  const current = activeBook ?? bookList[0]?.id ?? null;

  /* 当前词本的词表 */
  const words = useQuery({
    queryKey: ['words', current],
    queryFn: () => api<{ words: WordDTO[] }>(`/api/word-books/${current}`),
    enabled: !!current,
  });

  /* 建词本 */
  const createBook = useMutation({
    mutationFn: () => api('/api/word-books', { method: 'POST', body: JSON.stringify({ name: newBook }) }),
    onSuccess: () => {
      setNewBook('');
      void books.refetch();
    },
  });

  /** 生成 AI 笔记（任务内联轮询至终态；失败向下抛由 isPending/isError 呈现） */
  const genNote = useMutation({
    mutationFn: async (wordId: number) => {
      const r = await api<{ jobId: string }>(`/api/words/${wordId}/ai-note`, { method: 'POST' });
      await waitForJob(r.jobId);
    },
    // onSettled 而非 onSuccess：失败/超时时任务可能仍已落库（如超时前瞬间
    // 完成），无论成败都刷新词表，行状态反映 DB 真实落点
    onSettled: () => void words.refetch(),
  });

  return (
    /* 页面容器：移动单列 / 桌面两栏 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      <header className="mb-6">
        {/* 页标题 */}
        <h2 className="font-serif text-2xl md:text-3xl">词藏</h2>
        {/* 副标题：复习与深研入口指引（智能复习轮转牢记 / 研习手册词汇深研） */}
        <p className="mt-1 text-sm text-ochre">
          划词收录，日积月累 ——{' '}
          <Link href="/review" className="underline underline-offset-2 hover:text-primary">
            智能复习
          </Link>{' '}
          轮转牢记 ·{' '}
          <Link href="/manual" className="underline underline-offset-2 hover:text-primary">
            研习手册
          </Link>{' '}
          深研一词
        </p>
      </header>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* 词本列表栏 */}
        <aside className="w-full shrink-0 md:w-56">
          {/* 新建词本 */}
          <form
            className="deckle mb-3 flex gap-1.5 rounded-md border bg-card p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newBook.trim()) createBook.mutate();
            }}
          >
            <input
              value={newBook}
              onChange={(e) => setNewBook(e.target.value)}
              placeholder="新词本名"
              className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5 text-xs"
            />
            <button type="submit" disabled={!newBook.trim()} className="rounded bg-secondary px-2.5 py-1 text-xs text-secondary-foreground disabled:opacity-40">
              建
            </button>
          </form>
          {/* 词本项 */}
          {bookList.map((b) => (
            <button
              key={b.id}
              onClick={() => setActiveBook(b.id)}
              className={`mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                current === b.id ? 'bg-accent font-medium text-primary' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <span className="truncate">{b.name}</span>
              <span className="ml-2 shrink-0 text-xs text-ochre">{b.wordCount}</span>
            </button>
          ))}
          {bookList.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              还没有词本；在播放页点词即可收入默认词本
            </p>
          )}
        </aside>

        {/* 词表栏 */}
        <section className="min-w-0 flex-1">
          {words.isLoading ? (
            <p className="py-12 text-center text-sm text-muted-foreground">装载中…</p>
          ) : (words.data?.words ?? []).length === 0 ? (
            <div className="deckle rounded-md border border-dashed bg-card/50 py-14 text-center">
              <p className="font-serif">此本尚空</p>
              <p className="mt-1 text-xs text-muted-foreground">在播放页点词 →「+ 生词本」收录</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {(words.data?.words ?? []).map((w) => (
                <WordRow
                  key={w.id}
                  word={w}
                  expanded={expanded === w.id}
                  onToggle={() => setExpanded(expanded === w.id ? null : w.id)}
                  onGenNote={() => genNote.mutate(w.id)}
                  // 以 mutation 自身的 variables（发起时的 wordId）判行，而非
                  // 当前端开行——A 生成中收起转开 B 时，B 不会误显「生成中」
                  notePending={genNote.isPending && genNote.variables === w.id}
                  noteError={genNote.isError && genNote.variables === w.id ? errMsg(genNote.error) : null}
                  onSaved={() => void words.refetch()}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * 单词条：折叠态（词条+状态）与展开态（笔记编辑/预览 + AI 笔记）
 */
function WordRow({
  word,
  expanded,
  onToggle,
  onGenNote,
  notePending,
  noteError,
  onSaved,
}: {
  word: WordDTO;
  expanded: boolean;
  onToggle: () => void;
  onGenNote: () => void;
  /** AI 笔记生成中（父级 mutation 状态下发，驱动按钮禁用与文案） */
  notePending: boolean;
  /** AI 笔记生成失败信息（null=无失败） */
  noteError: string | null;
  onSaved: () => void;
}) {
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState(word.noteMd ?? '');
  // 按钮文案先行计算（顺序赋值，不用嵌套三元）
  let noteLabel = word.aiNoteStatus === 'ready' ? '重新生成' : '生成';
  if (notePending) noteLabel = '生成中…';

  /* ---- 深学卡（词源拓扑 + 仿写构架，M4）---- */
  const deep = useQuery({
    queryKey: ['deep', word.id],
    queryFn: () =>
      api<{
        etymology: { origin: string; roots: Array<{ part: string; meaning: string; lang?: string }>; related: Array<{ word: string; relation: string }> } | null;
        frames: Array<{ pattern: string; tip?: string }> | null;
      }>(`/api/words/${word.id}/deep`),
    enabled: expanded,
  });
  const genDeep = useMutation({
    mutationFn: async () => {
      const r = await api<{ cached?: boolean; jobId?: string }>(`/api/words/${word.id}/deep`, {
        method: 'POST',
        // force 与已有数据绑定：按钮文案为「重新生成」时必须真重生成（幂等分支只对首次）
        body: JSON.stringify({ force: Boolean(deep.data?.etymology && deep.data?.frames) }),
      });
      if (r.cached || !r.jobId) return;
      // 轮询收在 mutationFn 内：isPending 全程为真（不会提前恢复可点致重复建任务），
      // 终态/失败/超时都有明确出口，卸载也不留游离定时器
      await waitForJob(r.jobId);
    },
    onSuccess: () => void deep.refetch(),
  });

  const saveNote = useMutation({
    mutationFn: () =>
      api(`/api/words/${word.id}`, { method: 'PATCH', body: JSON.stringify({ noteMd: note }) }),
    onSuccess: () => {
      setEditNote(false);
      onSaved();
    },
  });

  return (
    /* 词条容器：纸卡 */
    <div className="deckle rounded-md border bg-card">
      {/* 折叠头：词条 + AI/人工笔记标记 + 深研入口（py-3 在折叠钮上：整行
          高度都是展开/收起热区——挪到容器上的话上下留白带的点按会失效） */}
      <div className="flex items-center gap-2 px-4">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left">
          <span className="font-serif text-lg">{word.displayForm}</span>
          <span className="ml-auto flex shrink-0 gap-1.5 text-[10px]">
            {word.noteMd && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">笔记</span>}
            {word.aiNoteStatus === 'ready' && <span className="rounded-full bg-secondary/10 px-2 py-0.5 text-secondary">AI</span>}
            {word.aiNoteStatus === 'pending' && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">生成中</span>}
          </span>
          <span className="material-symbols-outlined shrink-0 text-lg text-muted-foreground">
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
        </button>
        {/* 研习手册深研入口：直达该词的手册页（语境/词源/辨析/拼字/仿写）。
            size-10 ≥44px 级触控目标并留 gap：紧贴折叠钮的 32px 小热区在触屏上
            稍偏一点就会误触展开/收起 */}
        <Link
          href={`/manual?wordId=${word.id}`}
          aria-label={`研习手册深研 ${word.displayForm}`}
          className="ml-1 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-primary"
        >
          <span className="material-symbols-outlined text-lg">menu_book</span>
        </Link>
      </div>

      {/* 展开体 */}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {/* 深学卡：词源拓扑 + 仿写构架（M4） */}
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">深学卡 · 词源与构架</h4>
              {/* 深学卡生成按钮（pending 全程禁用，防重复建任务） */}
              <button
                onClick={() => genDeep.mutate()}
                disabled={genDeep.isPending}
                className="flex items-center gap-1 rounded border border-secondary/50 px-2.5 py-1 text-xs text-secondary disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-sm">account_tree</span>
                {deep.data?.etymology && deep.data?.frames ? '重新生成' : genDeep.isPending ? '生成中…' : '生成'}
              </button>
            </div>
            {/* 深学卡生成失败提示 */}
            {genDeep.isError && <p className="mb-1.5 text-xs text-destructive">生成失败：{errMsg(genDeep.error)}</p>}
            {deep.isLoading ? (
              <p className="text-xs text-muted-foreground">装载中…</p>
            ) : deep.data?.etymology ? (
              <div className="rounded-md bg-muted/40 p-3 text-xs">
                {/* 词源概述 */}
                <p className="text-sm">{deep.data.etymology.origin}</p>
                {/* 构词成分（拓扑根节点） */}
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
                {/* 仿写构架 */}
                {deep.data?.frames && deep.data.frames.length > 0 && (
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
              <p className="text-xs text-muted-foreground">尚未生成（需在设置页配置 LLM 档案）</p>
            )}
          </div>

          {/* 我的笔记 */}
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">我的笔记</h4>
              {editNote ? (
                <span className="flex gap-2 text-xs">
                  <button onClick={() => saveNote.mutate()} disabled={saveNote.isPending} className="rounded bg-primary px-2.5 py-1 text-primary-foreground">
                    保存
                  </button>
                  <button onClick={() => setEditNote(false)} className="rounded border border-border px-2.5 py-1">
                    取消
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => {
                    setNote(word.noteMd ?? '');
                    setEditNote(true);
                  }}
                  className="rounded border border-border px-2.5 py-1 text-xs"
                >
                  编辑
                </button>
              )}
            </div>
            {editNote ? (
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Markdown 笔记…"
                className="min-h-24 w-full rounded border border-input bg-background p-2 font-mono text-xs"
              />
            ) : (
              <MarkdownView source={word.noteMd} />
            )}
          </div>
          {/* AI 笔记 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-xs font-medium text-muted-foreground">AI 笔记</h4>
              {/* AI 笔记生成按钮（pending 全程禁用，防重复建任务） */}
              <button
                onClick={onGenNote}
                disabled={notePending}
                className="flex items-center gap-1 rounded border border-secondary/50 px-2.5 py-1 text-xs text-secondary disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-sm">auto_awesome</span>
                {noteLabel}
              </button>
            </div>
            {/* AI 笔记生成失败提示 */}
            {noteError && <p className="mb-1.5 text-xs text-destructive">生成失败：{noteError}</p>}
            {word.aiNoteStatus === 'pending' ? (
              <p className="text-xs text-primary">AI 笔记生成中…（可在本页等待，或稍后回来查看）</p>
            ) : word.aiNoteMd ? (
              <MarkdownView source={word.aiNoteMd} />
            ) : (
              <p className="text-xs text-muted-foreground">尚未生成（需在设置页配置 LLM 档案）</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
