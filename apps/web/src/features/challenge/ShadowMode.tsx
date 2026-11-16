'use client';

/**
 * 跟读评分 / 影子跟读玩法（需求 17 玩法三、四，共用组件）
 *
 * - shadow_score（跟读评分）：先听原句 → 录音 → AI 评分
 * - shadowing（影子跟读）：原句播放与录音同时开始（同步跟读），句尾自动停，同法评分
 * 评分双路径（/api/cues/:id/shadow-score 自动路由）：配置口语评测档案时走云端
 * SOE（三维分 + 词级着色）；否则本地 STT 近似评分（词级 diff）。
 */

import { useState } from 'react';
import type { ShadowScoreDTO, SpeechEvalWord } from '@pinglc/core';
import { api } from '@/lib/api';
import type { CueDTO } from '@/lib/api';
import { useRecorder } from '@/features/practice/useRecorder';
import { playSentenceOnce, stopPlayback } from '@/features/practice/playUtils';
import { ChallengeShell, useChallengeRun } from './ChallengeShell';

/** 评分响应（契约见 @pinglc/core ShadowScoreDTO） */
type ScoreResp = ShadowScoreDTO;

/**
 * 词级徽标着色：按评测 matchTag 与词准确度
 * matchTag 语义（腾讯 SOE）：0 匹配 / 1 增读 / 2 漏读 / 3 错读 / 4 未录入
 * @param w 词级评分
 */
function wordChipClass(w: SpeechEvalWord): string {
  if (w.matchTag === 2) return 'text-muted-foreground line-through'; // 漏读：该读没读
  if (w.matchTag === 1 || w.matchTag === 3) return 'text-destructive'; // 增读/错读
  if (w.matchTag === 4) return 'text-muted-foreground'; // 未录入：评测词典无此词，中性灰
  return w.accuracy >= 80 ? 'text-secondary' : 'text-ochre'; // 匹配词：按准确度分色
}

/**
 * 跟读玩法（双模式）
 * @param props.mode shadow_score=先听后读；shadowing=同步跟读
 */
export function ShadowMode({
  cues,
  materialId,
  mode,
  onExit,
}: {
  cues: CueDTO[];
  materialId: number;
  mode: 'shadow_score' | 'shadowing';
  onExit: () => void;
}) {
  const run = useChallengeRun(cues.length);
  const cue = cues[run.current];
  const [result, setResult] = useState<ScoreResp | null>(null);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 录音完成 → 提交评分 */
  const recorder = useRecorder({
    onDone: async (r) => {
      if (!cue) return;
      setScoring(true);
      setError(null);
      try {
        const resp = await fetch(`/api/cues/${cue.id}/shadow-score`, {
          method: 'POST',
          body: r.blob,
        });
        const data = (await resp.json()) as ScoreResp & { error?: string };
        if (!resp.ok || data.error) throw new Error(data.error ?? '评分失败');
        setResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '评分失败');
      } finally {
        setScoring(false);
      }
    },
  });

  const startRecording = () => {
    if (!cue) return;
    setResult(null);
    if (mode === 'shadowing') {
      // 影子跟读：先等录音就绪（首次还需过权限框，耗时不定）再起播——旧实现
      // 播放先跑、录音晚几百毫秒，句首必错位、评分白扣准确度
      void recorder.start().then(() => playSentenceOnce(cue.startMs, cue.endMs));
    } else {
      void recorder.start();
    }
  };

  const next = (score: number) => {
    setResult(null);
    setError(null);
    stopPlayback();
    run.advance(score);
    if (run.current + 1 >= cues.length) {
      const total = [...run.scores, score];
      // 经 api() 统一错误契约，失败告警不静默（结算视图不渲染 children）
      void api(`/api/materials/${materialId}/challenge`, {
        method: 'POST',
        body: JSON.stringify({ mode, score: Math.round(total.reduce((a, b) => a + b, 0) / total.length) }),
      }).catch((err: unknown) => console.warn('闯关成绩上报失败（不影响本轮）', err));
    }
  };

  if (!cue) return null;

  return (
    <ChallengeShell
      cues={cues}
      title={mode === 'shadowing' ? '影子跟读' : '跟读评分'}
      current={run.current}
      onExit={onExit}
      finished={run.finished}
      finalScore={run.scores.length ? Math.round(run.scores.reduce((a, b) => a + b, 0) / run.scores.length) : null}
      onRestart={run.restart}
    >
      {/* 原句对照 */}
      <div className="deckle rounded-md border bg-card p-4">
        <p className="font-serif text-lg leading-relaxed">{cue.textEn}</p>
        {cue.textZh && <p className="mt-1 text-sm text-muted-foreground">{cue.textZh}</p>}
      </div>

      {/* 操作区：听（仅 shadow_score）/ 录 / 停 */}
      <div className={`grid gap-2 ${mode === 'shadow_score' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {mode === 'shadow_score' && (
          <button
            onClick={() => playSentenceOnce(cue.startMs, cue.endMs)}
            disabled={recorder.state === 'recording'}
            className="deckle flex items-center justify-center gap-2 rounded-md border bg-card py-3.5 text-sm disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-2xl text-primary">volume_up</span>
            先听原句
          </button>
        )}
        <button
          onClick={() => (recorder.state === 'recording' ? recorder.stop() : startRecording())}
          className={`flex items-center justify-center gap-2 rounded-md py-3.5 text-sm text-primary-foreground ${
            recorder.state === 'recording' ? 'bg-destructive' : 'bg-primary'
          }`}
        >
          <span className="material-symbols-outlined text-2xl">
            {recorder.state === 'recording' ? 'stop_circle' : mode === 'shadowing' ? 'play_circle' : 'mic'}
          </span>
          {recorder.state === 'recording'
            ? `停止 ${(recorder.elapsedMs / 1000).toFixed(1)}s`
            : mode === 'shadowing'
              ? '同步跟读（播放+录音）'
              : '录音跟读'}
        </button>
      </div>

      {recorder.error && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{recorder.error}</p>}
      {scoring && <p className="text-center text-xs text-primary">AI 评分中…</p>}
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}

      {/* 评分结果 */}
      {result && (
        <div className="deckle rounded-md border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className={`font-serif text-3xl ${result.score >= 80 ? 'text-secondary' : result.score >= 60 ? 'text-ochre' : 'text-destructive'}`}>
              {result.score}
            </span>
            <div className="text-xs text-muted-foreground">
              <p>{result.score >= 80 ? '发音清晰，词句完整' : result.score >= 60 ? '大体正确，注意漏词或发音' : '再练一遍——漏词较多或发音不清'}</p>
              {result.heard && <p className="mt-1 italic">听到你说：{result.heard.slice(0, 120)}</p>}
              {result.note && <p className="mt-1">{result.note}</p>}
            </div>
          </div>
          {/* 云端口语评测：三维分 + 词级着色（绿=好 黄=待改进 红=增读/错读 灰删除=漏读 灰=未收录） */}
          {result.engine === 'soe' && result.detail && (
            <>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                {/* 准确度（0~100） */}
                <span>准确 <b className="text-foreground">{Math.round(result.detail.accuracy)}</b></span>
                {/* 流利度（0~100） */}
                <span>流利 <b className="text-foreground">{Math.round(result.detail.fluency)}</b></span>
                {/* 完成度（0~1，展示为百分比） */}
                <span>完整 <b className="text-foreground">{Math.round(result.detail.completion * 100)}%</b></span>
              </div>
              {result.detail.words.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 font-serif text-base leading-relaxed">
                  {/* 逐词徽标：着色规则见 wordChipClass */}
                  {result.detail.words.map((w, i) => (
                    <span key={`${w.word}-${i}`} className={wordChipClass(w)} title={`准确度 ${Math.round(w.accuracy)}`}>
                      {w.word}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10px] text-border">
                灰删除线=漏读 · 红=增读/错读 · 灰=未收录词 · 黄=待改进 · 绿=良好
              </p>
            </>
          )}
          <button onClick={() => next(result.score)} className="mt-3 w-full rounded-md bg-primary py-2.5 text-sm text-primary-foreground">
            下一句
          </button>
        </div>
      )}
    </ChallengeShell>
  );
}
