'use client';

/**
 * 「当前句」标签页（需求 8）
 *
 * - 一键复制原文/译文
 * - 点词：暂停播放 → 英音朗读 → 弹出「加生词」入口
 * - 句子笔记：Markdown 编辑 + 预览切换
 * - AI 解析并收藏（分类选择；重新生成走收藏页）
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { extractWords } from '@pinglc/core';
import { usePlayer } from '@/features/player/store';
import { MarkdownView } from '@/components/MarkdownView';
import { api, type CueDTO } from '@/lib/api';

/**
 * 当前句标签页
 * @param props.cue 当前激活句段（null 时显示空态）
 * @param props.materialId 材料 id
 */
export function CurrentSentenceTab({ cue, materialId }: { cue: CueDTO | null; materialId: number }) {
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);
  const [noteEdit, setNoteEdit] = useState(false);
  const [note, setNote] = useState<string>('');
  const [noteLoadedFor, setNoteLoadedFor] = useState<number>(-1);
  const [toast, setToast] = useState('');
  const [wordPopover, setWordPopover] = useState<{ word: string; x: number; y: number } | null>(null);

  // 笔记状态跟随激活句切换（首次进入编辑态时装载）
  const notePreview = cue?.noteMd ?? '';
  if (cue && noteEdit && noteLoadedFor !== cue.id) {
    setNote(cue.noteMd ?? '');
    setNoteLoadedFor(cue.id);
  }

  /** 词列表（保留标点上下文中的词，点击命中朗读） */
  const words = useMemo(() => (cue ? extractWords(cue.textEn) : []), [cue]);

  /** 复制到剪贴板 + toast */
  const copy = async (text: string | null, label: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setToast(`已复制${label}`);
    setTimeout(() => setToast(''), 1500);
  };

  /** 保存笔记 */
  const saveNote = useMutation({
    mutationFn: (md: string) =>
      api(`/api/cues/${cue!.id}`, { method: 'PATCH', body: JSON.stringify({ noteMd: md }) }),
    onSuccess: () => {
      setNoteEdit(false);
      setToast('笔记已保存');
      setTimeout(() => setToast(''), 1500);
    },
  });

  /** AI 解析并收藏 */
  const analyze = useMutation({
    mutationFn: () =>
      api<{ favoriteId: number; jobId: string }>(`/api/cues/${cue!.id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      setToast('已收藏，AI 解析生成中…（完成后在「句藏」查看）');
      setTimeout(() => setToast(''), 2600);
    },
    onError: (e) => {
      setToast(e instanceof Error ? e.message : '解析失败');
      setTimeout(() => setToast(''), 2600);
    },
  });

  /* ---- AI 关卡页（需求 8：生成本句交互闯关网页）---- */
  const [levelReady, setLevelReady] = useState(false);
  const [levelOpen, setLevelOpen] = useState<number | null>(null); // artifactId（打开弹窗）
  const level = useMutation({
    mutationFn: async () => {
      // 先查缓存；无则生成任务并轮询
      const cur = await api<{ artifact: { id: number } | null }>(`/api/cues/${cue!.id}/level`);
      if (cur.artifact) return cur.artifact.id;
      const { jobId } = await api<{ jobId: string }>(`/api/cues/${cue!.id}/level`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const { job } = await api<{ job: { status: string; error: string | null } }>(`/api/jobs/${jobId}`);
        if (job.status === 'succeeded') {
          const done = await api<{ artifact: { id: number } | null }>(`/api/cues/${cue!.id}/level`);
          if (done.artifact) return done.artifact.id;
          throw new Error('关卡生成完成但产物缺失');
        }
        if (job.status === 'failed') throw new Error(job.error ?? '生成失败');
      }
      throw new Error('生成超时');
    },
    onSuccess: (artifactId) => {
      setLevelReady(true);
      setLevelOpen(artifactId);
    },
  });
  /** 查询已有关卡（跟随激活句切换重置） */
  useEffect(() => {
    setLevelReady(false);
    setLevelOpen(null);
    if (cue) {
      void api<{ artifact: { id: number } | null }>(`/api/cues/${cue.id}/level`).then((r) => {
        if (r.artifact) setLevelReady(true);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只依赖句 id（cue 对象每次渲染新建）
  }, [cue?.id]);
  const ensureLevel = async () => {
    if (levelReady) {
      // 已有：直接打开最新
      const r = await api<{ artifact: { id: number } | null }>(`/api/cues/${cue!.id}/level`);
      if (r.artifact) setLevelOpen(r.artifact.id);
      return;
    }
    level.mutate();
  };

  /** 点词 → 加生词本 */
  const addWord = useMutation({
    mutationFn: (word: string) =>
      api<{ id: number; duplicate?: boolean }>('/api/words', {
        method: 'POST',
        body: JSON.stringify({ word, cueId: cue?.id, materialId }),
      }),
    onSuccess: (r) => {
      setWordPopover(null);
      setToast(r.duplicate ? '已在生词本中' : '已加入生词本');
      setTimeout(() => setToast(''), 1500);
    },
  });

  if (!cue) {
    return (
      /* 空态：播放间隙 */
      <div className="flex flex-col items-center py-16 text-muted-foreground">
        <span className="material-symbols-outlined mb-2 text-3xl">graphic_eq</span>
        <p className="text-sm">播放中，等待当前句…</p>
      </div>
    );
  }

  return (
    /* 当前句容器：英文词块 + 中文 + 操作排 + 笔记区 */
    <div className="flex flex-col gap-4 py-4">
      {/* 英文原文：词级 span，点击 = 暂停 + 朗读 + 气泡（需求 8） */}
      <p className="font-serif text-xl leading-loose md:text-2xl">
        {words.map((w, i) => (
          <span
            key={i}
            className="cursor-pointer rounded-sm px-[1px] transition-colors hover:bg-[rgba(185,28,28,0.12)]"
            onClick={(e) => {
              // 需求 8：点词先停止播放（真实媒体暂停），再朗读该词
              window.dispatchEvent(new CustomEvent('pinglc:pause'));
              usePlayer.getState().speakWord(w);
              setWordPopover({ word: w, x: e.clientX, y: e.clientY });
            }}
          >
            {w}
          </span>
        )).reduce<React.ReactNode[]>((acc, el, i) => (i === 0 ? [el] : [...acc, ' ', el]), [])}
      </p>

      {/* 中文译文 */}
      {cue.textZh && <p className="text-base leading-relaxed text-muted-foreground">{cue.textZh}</p>}

      {/* 操作排：复制原文/译文、AI 解析收藏 */}
      <div className="flex flex-wrap gap-2">
        <ActionChip icon="content_copy" label="复制原文" onClick={() => void copy(cue.textEn, '原文')} />
        <ActionChip icon="content_copy" label="复制译文" onClick={() => void copy(cue.textZh, '译文')} />
        <ActionChip
          icon="auto_awesome"
          label="AI 解析并收藏"
          busy={analyze.isPending}
          onClick={() => analyze.mutate()}
        />
        <ActionChip
          icon="stadia_controller"
          label={levelReady ? "打开关卡" : "生成关卡"}
          busy={level.isPending}
          onClick={() => void ensureLevel()}
        />
        <span className="ml-auto self-center text-xs text-ochre">
          第 {activeCueIndex + 1} 句
          {cue.sttConfidence != null && ` · 置信 ${Math.round(cue.sttConfidence * 100)}%`}
        </span>
      </div>

      {/* 句子笔记：预览/编辑切换 */}
      <section className="deckle rounded-md border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-serif text-sm font-medium">句子笔记</h3>
          {noteEdit ? (
            <div className="flex gap-2">
              <button
                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground"
                onClick={() => saveNote.mutate(note)}
                disabled={saveNote.isPending}
              >
                保存
              </button>
              <button
                className="rounded border border-border px-3 py-1 text-xs"
                onClick={() => setNoteEdit(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              className="rounded border border-border px-3 py-1 text-xs"
              onClick={() => setNoteEdit(true)}
            >
              编辑
            </button>
          )}
        </div>
        {noteEdit ? (
          /* Markdown 编辑器：等宽 textarea + 预览区（编辑态下双栏，移动端上下） */
          <div className="flex flex-col gap-3 md:flex-row">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="用 Markdown 记笔记…"
              className="min-h-40 flex-1 rounded border border-input bg-background p-3 font-mono text-xs"
            />
            <div className="min-h-40 flex-1 rounded border border-border bg-background p-3">
              <MarkdownView source={note} />
            </div>
          </div>
        ) : (
          <MarkdownView source={notePreview} />
        )}
      </section>

      {/* AI 关卡页弹窗（沙箱 iframe：无同源权限，CSP 由服务路由下发） */}
      {levelOpen !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={() => setLevelOpen(null)}>
          <div className="deckle flex h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h4 className="font-serif text-sm">本句闯关 · AI 关卡</h4>
              <button onClick={() => setLevelOpen(null)} aria-label="关闭关卡" className="flex size-8 items-center justify-center rounded">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            {/* sandbox 不带 allow-same-origin：页面脚本无法触达父页与 Cookie */}
            <iframe
              src={`/artifacts/${levelOpen}`}
              title="AI 关卡"
              sandbox="allow-scripts"
              className="flex-1 border-0"
            />
          </div>
        </div>
      )}

      {/* toast 提示（复用全局样式，居底浮出） */}
      {toast && (
        <div className="fixed inset-x-0 bottom-24 z-40 flex justify-center md:bottom-8">
          <p className="rounded-md bg-foreground px-4 py-2 text-xs text-background">{toast}</p>
        </div>
      )}

      {/* 点词气泡：朗读中提示 + 加生词 */}
      {wordPopover && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setWordPopover(null)} />
          <div
            className="deckle fixed z-50 flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg"
            style={{ left: Math.min(wordPopover.x, window.innerWidth - 180), top: wordPopover.y + 16 }}
          >
            {/* 单词本体：可再次朗读 */}
            <button
              className="font-serif font-medium text-primary"
              onClick={() => usePlayer.getState().speakWord(wordPopover.word)}
            >
              {wordPopover.word}
            </button>
            <span className="text-xs text-ochre">朗读中…</span>
            <button
              className="rounded bg-secondary px-2 py-1 text-xs text-secondary-foreground"
              onClick={() => addWord.mutate(wordPopover.word)}
              disabled={addWord.isPending}
            >
              + 生词本
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 操作小按钮（纸墨 chip）
 */
function ActionChip({
  icon,
  label,
  onClick,
  busy,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span className="material-symbols-outlined text-base">{busy ? 'hourglass_top' : icon}</span>
      {label}
    </button>
  );
}
