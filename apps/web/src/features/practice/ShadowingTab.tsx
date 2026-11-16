'use client';

/**
 * 「跟读」标签页（需求 11：听原文、录音、播放录音）
 *
 * - 听原文：单句播放（到句尾自停）
 * - 录音：MediaRecorder（安全上下文约束与权限错误就地提示）
 * - 播放录音：录制后即时回放 + 历史录音列表（可播放/删除）
 * - 跟读评分在 M3 里程碑接入（对齐引擎）
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePlayer } from '@/features/player/store';
import { playSentenceOnce } from './playUtils';
import { useRecorder } from './useRecorder';
import { api } from '@/lib/api';
import type { CueDTO } from '@/lib/api';

/** 录音列表项 */
interface RecordingDTO {
  id: number;
  durationMs: number | null;
  createdAt: string;
}

/**
 * 跟读标签页
 * @param props.cues 全部句段
 */
export function ShadowingTab({ cues }: { cues: CueDTO[] }) {
  const activeCueIndex = usePlayer((s) => s.activeCueIndex);
  const qc = useQueryClient();
  const [index, setIndex] = useState(() => Math.max(0, activeCueIndex));
  const cue = cues[index];
  const [lastBlobUrl, setLastBlobUrlState] = useState<string | null>(null);
  /* blob URL 生命周期单一出口：更新先回收旧值（重录不泄漏），卸载兜底回收 */
  const lastBlobUrlRef = useRef<string | null>(null);
  const setLastBlobUrl = (url: string | null) => {
    if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    lastBlobUrlRef.current = url;
    setLastBlobUrlState(url);
  };
  const playbackRef = useRef<HTMLAudioElement | null>(null);

  /* 句序跟随播放器（初始值取 activeCueIndex 的既有意图补全）并随 cues 收敛：
     旧实现只在首渲染取一次，播放器切句后本页不跟；cues 变短时残留越界下标
     会静默渲染「暂无句段」，看起来像材料没内容 */
  useEffect(() => {
    const clamped = Math.min(Math.max(0, activeCueIndex), Math.max(0, cues.length - 1));
    setIndex((i) => (i === clamped ? i : clamped));
  }, [activeCueIndex, cues.length]);
  /* 卸载回收最后的回放 URL */
  useEffect(() => () => {
    if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
  }, []);

  /* 录音归属句锁定：录音开始时记下句 id——录音期间用户换句，
     完成的音频仍归属录音时那一句（否则错存到别的句子的历史里） */
  const recordCueIdRef = useRef<number | null>(null);

  /* 录音器：完成即上传（mime 一并上报——Safari 是 mp4，服务端按真实类型落扩展名） */
  const upload = useMutation({
    mutationFn: (r: { cueId: number; blob: Blob; durationMs: number; mime: string }) => {
      const params = new URLSearchParams({
        durationMs: String(Math.round(r.durationMs)),
        mime: r.mime.split(';')[0] ?? 'audio/webm',
      });
      return fetch(`/api/cues/${r.cueId}/recordings?${params}`, {
        method: 'POST',
        body: r.blob,
      }).then(async (resp) => {
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error ?? '上传失败');
        return data as { id: number };
      });
    },
    onSuccess: (_d, v) => {
      setLastBlobUrl(null); // 上传成功走历史列表回放
      recordCueIdRef.current = null;
      void qc.invalidateQueries({ queryKey: ['recordings', v.cueId] });
    },
  });
  const recorder = useRecorder({
    onDone: (r) => {
      // 本地即时回放 URL（未上传成功也可先听）；经 setLastBlobUrl 更新以回收旧值
      setLastBlobUrl(URL.createObjectURL(r.blob));
      const targetId = recordCueIdRef.current ?? cue?.id;
      if (targetId) upload.mutate({ cueId: targetId, blob: r.blob, durationMs: r.durationMs, mime: r.mime });
    },
  });

  /* 历史录音 */
  const list = useQuery({
    queryKey: ['recordings', cue?.id],
    queryFn: () => api<{ recordings: RecordingDTO[] }>(`/api/cues/${cue!.id}/recordings`),
    enabled: !!cue,
  });

  /* 删除录音 */
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/recordings/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recordings', cue?.id] }),
  });

  /* 播放历史录音 */
  const playRecording = (id: number) => {
    playbackRef.current?.pause();
    const audio = new Audio(`/api/recordings/${id}`);
    playbackRef.current = audio;
    void audio.play().catch(() => undefined);
  };

  /* 切句清理：回收回放 URL；结束进行中的录音（录完仍归属录音时的句子） */
  useEffect(() => {
    if (recorder.state === 'recording') recorder.stop();
    setLastBlobUrl(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (!cue) return <div className="py-16 text-center text-sm text-muted-foreground">暂无句段</div>;

  return (
    /* 跟读容器：原文卡 + 三步操作 + 历史列表 */
    <div className="flex flex-col gap-4 py-4">
      {/* 原文卡（对照朗读，中文可先藏） */}
      <div className="deckle rounded-md border bg-card p-4">
        <p className="font-serif text-lg leading-relaxed">{cue.textEn}</p>
        {cue.textZh && <p className="mt-1 text-sm text-muted-foreground">{cue.textZh}</p>}
      </div>

      {/* 句导航 */}
      <div className="flex items-center gap-2 text-sm">
        <button onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0} className="deckle rounded-md border px-3 py-1.5 disabled:opacity-40">
          ‹ 上一句
        </button>
        <span className="text-xs text-ochre">
          第 {index + 1}/{cues.length} 句
        </span>
        <button
          onClick={() => setIndex(Math.min(cues.length - 1, index + 1))}
          disabled={index >= cues.length - 1}
          className="deckle ml-auto rounded-md border px-3 py-1.5 disabled:opacity-40"
        >
          下一句 ›
        </button>
      </div>

      {/* 三步：听原文 → 录音 → 听录音 */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => playSentenceOnce(cue.startMs, cue.endMs)}
          className="deckle flex flex-col items-center gap-1 rounded-md border bg-card py-4 text-sm"
        >
          <span className="material-symbols-outlined text-2xl text-primary">volume_up</span>
          听原文
        </button>
        <button
          onClick={() => {
            if (recorder.state === 'recording') {
              recorder.stop();
            } else {
              // 锁定录音归属句（录音期间换句不错存）
              recordCueIdRef.current = cue?.id ?? null;
              void recorder.start();
            }
          }}
          className={`flex flex-col items-center gap-1 rounded-md py-4 text-sm text-primary-foreground ${
            recorder.state === 'recording' ? 'bg-destructive' : 'bg-primary'
          }`}
        >
          <span className="material-symbols-outlined text-2xl">
            {recorder.state === 'recording' ? 'stop_circle' : 'mic'}
          </span>
          {recorder.state === 'recording' ? `停止 ${(recorder.elapsedMs / 1000).toFixed(1)}s` : '录音跟读'}
        </button>
        <button
          onClick={() => {
            if (lastBlobUrl) void new Audio(lastBlobUrl).play();
            else if (list.data?.recordings[0]) playRecording(list.data.recordings[0].id);
          }}
          disabled={!lastBlobUrl && !list.data?.recordings.length}
          className="deckle flex flex-col items-center gap-1 rounded-md border bg-card py-4 text-sm disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-2xl text-secondary">play_circle</span>
          听录音
        </button>
      </div>

      {/* 录音器错误（权限/HTTPS） */}
      {recorder.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{recorder.error}</p>
      )}
      {upload.isError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          录音上传失败：{(upload.error as Error).message}
        </p>
      )}

      {/* 历史录音 */}
      <section>
        <h3 className="mb-2 text-xs font-medium text-ochre">历史跟读（{list.data?.recordings.length ?? 0}）</h3>
        {(list.data?.recordings ?? []).length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">还没有本句的跟读录音</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {(list.data?.recordings ?? []).map((r) => (
              <div key={r.id} className="deckle flex items-center gap-3 rounded-md border bg-card px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {new Date(r.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-ochre">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</span>
                <button onClick={() => playRecording(r.id)} className="ml-auto flex items-center gap-1 text-secondary">
                  <span className="material-symbols-outlined text-base">play_arrow</span>
                  播放
                </button>
                <button
                  onClick={() => remove.mutate(r.id)}
                  aria-label="删除录音"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <span className="material-symbols-outlined text-base">delete</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        跟读评分（发音对齐打分）将在 M3 里程碑随闯关模式一起交付。
      </p>
    </div>
  );
}
