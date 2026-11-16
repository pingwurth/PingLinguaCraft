'use client';

/**
 * 「双语精读」标签页（需求 7/9 + 设计稿 _2/_4 字幕工坊）
 *
 * - 字幕跟随播放进度滚动（激活句居中 + 朱砂左边线）：句列表为独立滚动容器，
 *   跟播只滚容器不动页面；用户滚轮/触摸浏览期间自动让位，停手片刻恢复跟随
 * - 逐条工坊操作：编辑原文/译文/时间（±100ms 步进）、单句重译（中英互译）、
 *   单句重 STT、下方插入、删除
 * - 卷级操作：导入字幕（整体替换）、导出（srt/vtt × en/zh/双语）、整卷重译、整卷重 STT
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePlayer } from '@/features/player/store';
import { api, type CueDTO, type JobDTO, type MaterialDetail } from '@/lib/api';

/**
 * 用户浏览让位窗口（毫秒）：字幕区内滚轮/触摸浏览期间跟播滚动暂停，
 * 停手该时长后自动恢复跟随。截止时间戳存模块级单例而非 state——
 * wheel 高频写入不该逐帧触发渲染，React 状态只保留一个样式开关。
 */
const FOLLOW_HOLD_MS = 2500;
const followHoldUntil = { at: 0 };

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

  /* follow/editingId 的 ref 镜像：滚动函数被切句 effect 与让位回弹计时器
     共用，后者闭包里的 React state 会过期，统一读 ref 取最新值 */
  const followRef = useRef(follow);
  followRef.current = follow;
  const editingRef = useRef<number | null>(editingId);
  editingRef.current = editingId;

  /** 跟播滚动：激活句在列表容器内居中（scrollIntoView 会连滚页面等全部
   *  可滚祖先、把整页顶飞，故改为容器内 scrollTo） */
  const scrollActiveIntoView = useCallback(() => {
    const idx = usePlayer.getState().activeCueIndex;
    if (!followRef.current || editingRef.current !== null || idx < 0) return;
    const c = listRef.current;
    const el = c?.querySelector<HTMLElement>(`[data-cue-idx="${idx}"]`);
    if (!c || !el) return;
    const cRect = c.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const delta = eRect.top - cRect.top - (c.clientHeight - el.clientHeight) / 2;
    c.scrollTo({ top: c.scrollTop + delta, behavior: 'smooth' });
  }, []);

  /* 切句跟播：激活句/开关/编辑态变化时滚动；用户浏览让位期内
     （滚轮/触摸操作后 FOLLOW_HOLD_MS 内）切句不强制滚动 */
  useEffect(() => {
    if (Date.now() < followHoldUntil.at) return; // 用户正在浏览：让位
    scrollActiveIntoView();
  }, [activeCueIndex, follow, editingId, scrollActiveIntoView]);

  /* 浏览让位：字幕区 wheel/触摸 → 暂停跟播并起恢复计时；state 仅用于按钮样式 */
  const [followHeld, setFollowHeld] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const c = listRef.current;
    if (!c) return;
    const hold = () => {
      followHoldUntil.at = Date.now() + FOLLOW_HOLD_MS;
      setFollowHeld(true);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => {
        setFollowHeld(false);
        // 让位结束：主动回弹定位当前句——不能等下一次切句触发（单句循环/
        // 暂停时 activeCueIndex 恒定，effect 不再重跑，不回弹就永不恢复）
        scrollActiveIntoView();
      }, FOLLOW_HOLD_MS);
    };
    c.addEventListener('wheel', hold, { passive: true });
    c.addEventListener('touchmove', hold, { passive: true });
    return () => {
      c.removeEventListener('wheel', hold);
      c.removeEventListener('touchmove', hold);
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, [scrollActiveIntoView]);

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

  /** 句段操作失败的统一提示：低频操作用 alert（错误文案来自 api() 统一契约），
   *  此前五个 mutation 只有 onSuccess——删除/插入/重译失败界面毫无反馈，用户
   *  误以为成功 */
  const opAlert = (label: string) => (err: Error) => alert(`${label}失败：${err.message}`);

  /** 单句重译 */
  const retranslate = useMutation({
    mutationFn: (v: { id: number; direction: 'en2zh' | 'zh2en' }) =>
      api(`/api/cues/${v.id}/retranslate`, {
        method: 'POST',
        body: JSON.stringify({ direction: v.direction }),
      }),
    onSuccess: refresh,
    onError: opAlert('重新翻译'),
  });

  /** 单句重 STT（任务） */
  const resttCue = useMutation({
    mutationFn: (id: number) => api(`/api/cues/${id}/restt`, { method: 'POST', body: '{}' }),
    onSuccess: refresh,
    onError: opAlert('重听转写'),
  });

  /** 删除句段 */
  const removeCue = useMutation({
    mutationFn: (id: number) => api(`/api/cues/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: opAlert('删除句段'),
  });

  /** 下方插入 */
  const insertCue = useMutation({
    mutationFn: (afterIndex: number) =>
      api(`/api/materials/${material.id}/cues`, {
        method: 'POST',
        body: JSON.stringify({ afterIndex }),
      }),
    onSuccess: refresh,
    onError: opAlert('插入句段'),
  });

  /** 卷级操作 */
  const materialAction = useMutation({
    mutationFn: (v: { action: 'restt' | 'retranslate'; force?: boolean }) =>
      api<{ jobId: string }>(`/api/materials/${material.id}/${v.action}`, {
        method: 'POST',
        body: JSON.stringify({ force: v.force }),
      }),
    onSuccess: refresh,
    onError: opAlert('卷级操作'),
  });

  return (
    /* 精读容器：卷级工具条 + 滚动句列表 */
    <div className="flex flex-col py-2">
      {/* 卷级工具条 */}
      <div className="deckle sticky top-0 z-10 -mx-1 mb-2 flex flex-wrap items-center gap-2 border-b bg-background/95 px-1 pb-2 pt-1 backdrop-blur">
        {/* 跟播开关（浏览让位期间半透明示意：跟播仍开，停手片刻自动追上） */}
        <button
          onClick={() => setFollow((v) => !v)}
          title={followHeld ? '浏览中，跟播暂让位；停手片刻自动恢复跟随' : '跟播：激活句自动居中'}
          className={`flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs transition-opacity ${
            follow ? 'text-primary' : 'text-muted-foreground'
          } ${follow && followHeld ? 'opacity-50' : ''}`}
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

      {/* 句列表：独立滚动容器（跟播只滚此区不动页面；overscroll-contain 防滚到头
          链式带动整页；细滚动条贴合纸墨风——Firefox thin / WebKit 窄轨圆角） */}
      <div
        ref={listRef}
        className="flex max-h-[65dvh] flex-col gap-1.5 overflow-y-auto overscroll-contain pb-2 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
      >
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
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) {
      setEn(cue.textEn);
      setZh(cue.textZh ?? '');
      setStart(cue.startMs);
      setEnd(cue.endMs);
      setDirty(false);
      setSaveError(null);
    }
  }, [editing, cue]);

  /** 保存编辑（失败就地提示且不退出编辑态——用户输入不丢；此前 void 调用把
   *  rejection 变成未处理 Promise，行停在编辑态却无任何提示） */
  const save = async () => {
    try {
      await api(`/api/cues/${cue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ textEn: en, textZh: zh, startMs: start, endMs: end }),
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败');
      return;
    }
    setSaveError(null);
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
              // 真实跳播走 pinglc:seek（与常规态点正文跳播同通道，Player 内执行
              // currentTime 设置）——旧实现只 setCurrentTimeMs 更新 store 显示，
              // 进度条视觉跳动而音频不动，是「假试听」
              window.dispatchEvent(new CustomEvent('pinglc:seek', { detail: start }));
              onEdit();
            }}
          >
            试听
          </button>
        </div>
        {/* 保存失败就地提示（不退出编辑态） */}
        {saveError && <p className="mb-2 text-xs text-destructive">{saveError}</p>}
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
