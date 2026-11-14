'use client';

/**
 * 词藏页（需求 14：多个生词本、笔记 Markdown 编辑+预览、AI 自动生成单词笔记）
 *
 * 左右布局（移动上下）：词本列表 + 当前词本词表；
 * 词项展开：显示/编辑笔记、AI 笔记生成与查看。
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { api, type JobDTO } from '@/lib/api';

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

  /* AI 笔记任务轮询（展开的词在 pending 时轮询） */
  const aiJob = useQuery({
    queryKey: ['ai-note-job', expanded],
    queryFn: () => api<{ jobs: JobDTO[] }>('/api/jobs'),
    enabled: false, // 由 mutation onSuccess 手动触发一次刷新
  });
  void aiJob;

  /* 建词本 */
  const createBook = useMutation({
    mutationFn: () => api('/api/word-books', { method: 'POST', body: JSON.stringify({ name: newBook }) }),
    onSuccess: () => {
      setNewBook('');
      void books.refetch();
    },
  });

  /** 生成 AI 笔记（任务） */
  const genNote = useMutation({
    mutationFn: (wordId: number) => api<{ jobId: string }>(`/api/words/${wordId}/ai-note`, { method: 'POST' }),
    onSuccess: (_r, wordId) => {
      // 轮询任务完成（简化：定时刷新词表直至 ready/failed）
      const timer = setInterval(() => {
        void words.refetch();
        const w = words.data?.words.find((x) => x.id === wordId);
        if (w && w.aiNoteStatus !== 'pending') clearInterval(timer);
      }, 2000);
      setTimeout(() => clearInterval(timer), 120_000);
    },
  });

  return (
    /* 页面容器：移动单列 / 桌面两栏 */
    <div className="mx-auto w-full max-w-6xl px-5 py-6 md:px-12 md:py-10">
      <header className="mb-6">
        <h2 className="font-serif text-2xl md:text-3xl">词藏</h2>
        <p className="mt-1 text-sm text-ochre">划词收录，日积月累（复习系统将在 M4 交付）</p>
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
  onSaved,
}: {
  word: WordDTO;
  expanded: boolean;
  onToggle: () => void;
  onGenNote: () => void;
  onSaved: () => void;
}) {
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState(word.noteMd ?? '');

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
      {/* 折叠头：词条 + AI/人工笔记标记 */}
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="font-serif text-lg">{word.displayForm}</span>
        <span className="ml-auto flex gap-1.5 text-[10px]">
          {word.noteMd && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">笔记</span>}
          {word.aiNoteStatus === 'ready' && <span className="rounded-full bg-secondary/10 px-2 py-0.5 text-secondary">AI</span>}
          {word.aiNoteStatus === 'pending' && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">生成中</span>}
        </span>
        <span className="material-symbols-outlined text-lg text-muted-foreground">
          {expanded ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {/* 展开体 */}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
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
              <button onClick={onGenNote} className="flex items-center gap-1 rounded border border-secondary/50 px-2.5 py-1 text-xs text-secondary">
                <span className="material-symbols-outlined text-sm">auto_awesome</span>
                {word.aiNoteStatus === 'ready' ? '重新生成' : '生成'}
              </button>
            </div>
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
