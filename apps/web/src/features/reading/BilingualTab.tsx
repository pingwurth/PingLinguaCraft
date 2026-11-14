'use client';

/**
 * 「双语精读」标签页（需求 7/9 + 设计稿 _2/_4 字幕工坊）
 *
 * - 字幕跟随播放进度滚动（激活句居中 + 朱砂左边线）
 * - 逐条工坊操作：编辑原文/译文/时间（±100ms 步进）、单句重译（中英互译）、
 *   单句重 STT、下方插入、删除
 * - 卷级操作：导入字幕（整体替换）、导出（srt/vtt × en/zh/双语）、整卷重译、整卷重 STT
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePlayer } from '@/features/player/store';
import { api, type CueDTO, type JobDTO, type MaterialDetail } from '@/lib/api';

/**
 * 双语精读标签页
 * @param props.cues    句段列表
 * @param props.material 材料详情
 */
export function BilingualTab({ cues, material }: { cues: CueDTO[]; material: MaterialDetail }) {
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const qc = useQueryClient();

  /* 跟播滚动：激活句居中 */
  useEffect(() => {
    if (!follow || editingId !== null || activeCueIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cue-idx="${activeCueIndex}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeCueIndex, follow, editingId]);

  /* 活跃任务（卷级重译/重 STT 的进度显示） */
  const activeJobs = useQuery({
    queryKey: ['jobs', material.id],
    queryFn: () => api<{ jobs: JobDTO[] }>(`/api/jobs?materialId=${material.id}`),
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ? 1500 : false,
  });
  const runningJob = activeJobs.data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');

  /* 句段刷新（工坊编辑/任务完成后重拉） */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cues', material.id] });
    void activeJobs.refetch();
  };

  /** 单句重译 */
  const retranslate = useMutation({
    mutationFn: (v: { id: number; direction: 'en2zh' | 'zh2en' }) =>
      api(`/api/cues/${v.id}/retranslate`, {
        method: 'POST',
        body: JSON.stringify({ direction: v.direction }),
      }),
    onSuccess: refresh,
  });

  /** 单句重 STT（任务） */
  const resttCue = useMutation({
    mutationFn: (id: number) => api(`/api/cues/${id}/restt`, { method: 'POST', body: '{}' }),
    onSuccess: refresh,
  });

  /** 删除句段 */
  const removeCue = useMutation({
    mutationFn: (id: number) => api(`/api/cues/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  /** 下方插入 */
  const insertCue = useMutation({
    mutationFn: (afterIndex: number) =>
      api(`/api/materials/${material.id}/cues`, {
        method: 'POST',
        body: JSON.stringify({ afterIndex }),
      }),
    onSuccess: refresh,
  });

  /** 卷级操作 */
  const materialAction = useMutation({
    mutationFn: (v: { action: 'restt' | 'retranslate'; force?: boolean }) =>
      api<{ jobId: string }>(`/api/materials/${material.id}/${v.action}`, {
        method: 'POST',
        body: JSON.stringify({ force: v.force }),
      }),
    onSuccess: refresh,
  });

  return (
    /* 精读容器：卷级工具条 + 滚动句列表 */
    <div className="flex flex-col py-2">
      {/* 卷级工具条 */}
      <div className="deckle sticky top-0 z-10 -mx-1 mb-2 flex flex-wrap items-center gap-2 border-b bg-background/95 px-1 pb-2 pt-1 backdrop-blur">
        {/* 跟播开关 */}
        <button
          onClick={() => setFollow((v) => !v)}
          className={`flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs ${
            follow ? 'text-primary' : 'text-muted-foreground'
          }`}
        >
          <span className="material-symbols-outlined text-sm">{follow ? 'lock' : 'lock_open'}</span>
          跟播
        </button>
        {/* 导入字幕 */}
        <label className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs">
          <span className="material-symbols-outlined text-sm">upload</span>
          导入字幕
          <input
            type="file"
            accept=".srt,.vtt,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (!confirm('导入将整体替换现有字幕（含人工纠错），确定？')) return;
              const content = await f.text();
              try {
                await api(`/api/materials/${material.id}/subtitles`, {
                  method: 'POST',
                  body: JSON.stringify({ content, retranslate: true }),
                });
                refresh();
              } catch (err) {
                alert(err instanceof Error ? err.message : '导入失败');
              }
              e.target.value = '';
            }}
          />
        </label>
        {/* 导出字幕：srt 双语（下拉细分 M2） */}
        <a
          href={`/api/materials/${material.id}/subtitles?format=srt&mode=bilingual`}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs"
        >
          <span className="material-symbols-outlined text-sm">download</span>
          导出 SRT
        </a>
        <a
          href={`/api/materials/${material.id}/subtitles?format=vtt&mode=bilingual`}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs"
        >
          导出 VTT
        </a>
        {/* 卷级重译 / 重 STT */}
        <button
          onClick={() => materialAction.mutate({ action: 'retranslate', force: true })}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs"
        >
          <span className="material-symbols-outlined text-sm">translate</span>
          整卷重译
        </button>
        <button
          onClick={() => {
            if (confirm('整卷重新 STT 将替换全部原文与词级时间戳（译文丢弃），确定？')) {
              materialAction.mutate({ action: 'restt' });
            }
          }}
          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs"
        >
          <span className="material-symbols-outlined text-sm">graphic_eq</span>
          重新 STT
        </button>
      </div>

      {/* 活跃任务进度条 */}
      {runningJob && (
        <div className="mb-3 rounded-md border border-[#b91c1c]/30 bg-[#b91c1c]/5 px-3 py-2">
          <div className="flex justify-between text-xs">
            <span>{runningJob.message ?? runningJob.type}</span>
            <span>{Math.round(runningJob.progress * 100)}%</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
            <div className="h-full bg-primary transition-all" style={{ width: `${runningJob.progress * 100}%` }} />
          </div>
        </div>
      )}

      {/* 句列表 */}
      <div ref={listRef} className="flex flex-col gap-1.5">
        {cues.map((cue) => (
          <CueRow
            key={cue.id}
            cue={cue}
            active={cue.index === activeCueIndex}
            editing={editingId === cue.id}
            onEdit={() => setEditingId(editingId === cue.id ? null : cue.id)}
            onDone={refresh}
            onRetranslate={(d) => retranslate.mutate({ id: cue.id, direction: d })}
            onRestt={() => resttCue.mutate(cue.id)}
            onDelete={() => removeCue.mutate(cue.id)}
            onInsert={() => insertCue.mutate(cue.index)}
            busy={retranslate.isPending || resttCue.isPending}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 单条句段行：常规态（双语展示 + 跳播）与编辑态（工坊表单）
 */
function CueRow({
  cue,
  active,
  editing,
  onEdit,
  onDone,
  onRetranslate,
  onRestt,
  onDelete,
  onInsert,
  busy,
}: {
  cue: CueDTO;
  active: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onRetranslate: (d: 'en2zh' | 'zh2en') => void;
  onRestt: () => void;
  onDelete: () => void;
  onInsert: () => void;
  busy: boolean;
}) {
  const [en, setEn] = useState(cue.textEn);
  const [zh, setZh] = useState(cue.textZh ?? '');
  const [start, setStart] = useState(cue.startMs);
  const [end, setEnd] = useState(cue.endMs);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (editing) {
      setEn(cue.textEn);
      setZh(cue.textZh ?? '');
      setStart(cue.startMs);
      setEnd(cue.endMs);
      setDirty(false);
    }
  }, [editing, cue]);

  /** 保存编辑 */
  const save = async () => {
    await api(`/api/cues/${cue.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ textEn: en, textZh: zh, startMs: start, endMs: end }),
    });
    onEdit();
    onDone();
  };

  /** ms 显示 */
  const fmtMs = (ms: number) => {
    const s = ms / 1000;
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`;
  };

  if (editing) {
    return (
      /* 编辑态：工坊表单（原文/译文/时间 ±100ms/操作） */
      <div className="deckle rounded-md border-2 border-primary/50 bg-card p-3">
        {/* 原文 */}
        <textarea
          value={en}
          onChange={(e) => { setEn(e.target.value); setDirty(true); }}
          className="mb-2 min-h-16 w-full rounded border border-input bg-background p-2 font-serif text-base"
          placeholder="英文原文"
        />
        {/* 译文 */}
        <textarea
          value={zh}
          onChange={(e) => { setZh(e.target.value); setDirty(true); }}
          className="mb-2 min-h-14 w-full rounded border border-input bg-background p-2 text-sm"
          placeholder="中文译文（空=未翻译）"
        />
        {/* 时间控制：±100ms 步进 + 跳播试听 */}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <TimeStepper label="入点" value={start} onChange={(v) => { setStart(v); setDirty(true); }} />
          <TimeStepper label="出点" value={end} onChange={(v) => { setEnd(v); setDirty(true); }} />
          <button
            className="rounded border border-border px-2 py-1"
            onClick={() => {
              const s = usePlayer.getState();
              s.setCurrentTimeMs(start); // 视觉反馈；真实 seek 由 Player 内部处理
              onEdit();
            }}
          >
            试听
          </button>
        </div>
        {/* 操作排 */}
        <div className="flex flex-wrap gap-2 text-xs">
          <button className="rounded bg-primary px-3 py-1.5 text-primary-foreground" onClick={() => void save()} disabled={!dirty}>
            保存{dirty ? '' : '（无改动）'}
          </button>
          <button className="rounded border border-border px-3 py-1.5" onClick={onEdit}>
            收起
          </button>
          <button className="rounded border border-border px-3 py-1.5" onClick={() => onRetranslate('en2zh')} disabled={busy}>
            重新翻译
          </button>
          <button className="rounded border border-border px-3 py-1.5" onClick={() => onRetranslate('zh2en')} disabled={busy || !cue.textZh}>
            译文→英文
          </button>
          <button className="rounded border border-border px-3 py-1.5" onClick={onRestt} disabled={busy}>
            重新 STT
          </button>
          <button className="rounded border border-border px-3 py-1.5" onClick={onInsert}>
            下方插入
          </button>
          <button
            className="rounded border border-destructive/40 px-3 py-1.5 text-destructive"
            onClick={() => {
              if (confirm('删除该句段？')) onDelete();
            }}
          >
            删除
          </button>
        </div>
      </div>
    );
  }

  return (
    /* 常规态：双语行（激活句朱砂左边线），点正文跳播，点右上编辑 */
    <div
      data-cue-idx={cue.index}
      className={`deckle group relative rounded-md border bg-card px-3 py-2.5 transition-colors ${
        active ? 'border-[#b91c1c]/50 bg-[#b91c1c]/[0.04]' : 'border-border'
      }`}
    >
      {/* 激活句左边线 */}
      {active && <span className="absolute inset-y-0 left-0 w-[3px] rounded-l-md bg-primary" />}
      {/* 点击正文 → 跳播该句 */}
      <button
        className="w-full text-left"
        onClick={() => {
          const ev = new CustomEvent('pinglc:seek', { detail: cue.startMs });
          window.dispatchEvent(ev);
        }}
      >
        <p className="font-serif text-[15px] leading-relaxed">
          <span className="mr-2 text-xs text-ochre tabular-nums">{fmtMs(cue.startMs)}</span>
          {cue.textEn}
        </p>
        {cue.textZh && <p className="mt-0.5 pl-10 text-sm leading-relaxed text-muted-foreground">{cue.textZh}</p>}
      </button>
      {/* 行操作：编辑入口（hover 常显，移动端点行首） */}
      <div className="mt-1 flex items-center justify-end gap-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-60">
        {cue.isEdited && <span className="mr-auto text-ochre">已纠错</span>}
        <button onClick={onEdit} className="text-muted-foreground hover:text-primary">
          编辑
        </button>
      </div>
    </div>
  );
}

/**
 * 时间步进器（±100ms，工坊用）
 */
function TimeStepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <button className="rounded border border-border px-1.5 py-0.5" onClick={() => onChange(Math.max(0, value - 100))}>
        −
      </button>
      <span className="tabular-nums">{(value / 1000).toFixed(2)}s</span>
      <button className="rounded border border-border px-1.5 py-0.5" onClick={() => onChange(value + 100)}>
        +
      </button>
    </span>
  );
}
