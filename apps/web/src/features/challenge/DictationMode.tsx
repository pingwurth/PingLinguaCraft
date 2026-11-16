'use client';

/**
 * 单句听写玩法（需求 17 玩法二）
 *
 * 逐句：听句（可重听）→ 默写 → diffSentence 词级判分；得分即本句成绩。
 */

import { useEffect, useState } from 'react';
import { diffSentence } from '@pinglc/core';
import { playSentenceOnce } from '@/features/practice/playUtils';
import { api } from '@/lib/api';
import type { CueDTO } from '@/lib/api';
import { ChallengeShell, useChallengeRun } from './ChallengeShell';

/**
 * 单句听写玩法
 */
export function DictationMode({
  cues,
  materialId,
  onExit,
}: {
  cues: CueDTO[];
  materialId: number;
  onExit: () => void;
}) {
  const run = useChallengeRun(cues.length);
  const cue = cues[run.current];
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<ReturnType<typeof diffSentence> | null>(null);

  // 换句下标（解构为基本值供 effect 依赖；run 每次渲染都是新对象）
  const { current: runCurrent } = run;
  // 换句即清作答态（「再来一轮」restart 只重置状态机，本地作答须随之清理）
  useEffect(() => {
    setTyped('');
    setResult(null);
  }, [runCurrent]);

  const next = (score: number) => {
    run.advance(score);
    if (run.current + 1 >= cues.length) {
      const total = [...run.scores, score];
      // 经 api() 统一错误契约，失败告警不静默（结算视图不渲染 children）
      void api(`/api/materials/${materialId}/challenge`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'dictation', score: Math.round(total.reduce((a, b) => a + b, 0) / total.length) }),
      }).catch((err: unknown) => console.warn('闯关成绩上报失败（不影响本轮）', err));
    }
  };

  if (!cue) return null;

  return (
    <ChallengeShell
      cues={cues}
      title="单句听写"
      current={run.current}
      onExit={onExit}
      finished={run.finished}
      finalScore={run.scores.length ? Math.round(run.scores.reduce((a, b) => a + b, 0) / run.scores.length) : null}
      onRestart={run.restart}
    >
      {/* 听句 */}
      <button
        onClick={() => playSentenceOnce(cue.startMs, cue.endMs)}
        className="deckle flex items-center justify-center gap-2 rounded-md border bg-card py-3.5 text-sm font-medium"
      >
        <span className="material-symbols-outlined text-2xl text-primary">volume_up</span>
        听本句（可反复听）
      </button>

      {/* 默写输入 */}
      <textarea
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setResult(null);
        }}
        placeholder="默写整句…"
        disabled={!!result}
        className="min-h-24 w-full rounded-md border border-input bg-background p-3 font-serif text-base"
      />

      {/* 判分 */}
      {result && (
        <div className="flex flex-wrap gap-1.5 rounded-md bg-card p-3">
          {result.items.map((it, i) => (
            <span
              key={i}
              className={
                it.status === 'correct'
                  ? 'text-secondary'
                  : it.status === 'typo'
                    ? 'text-ochre'
                    : 'text-destructive'
              }
            >
              {it.target || it.typed}
            </span>
          ))}
          <span className="ml-auto self-center text-xs text-muted-foreground">本句 {Math.round(result.score * 100)} 分</span>
        </div>
      )}

      <div className="flex gap-2">
        {!result ? (
          <button
            onClick={() => setResult(diffSentence(cue.textEn, typed))}
            disabled={!typed.trim()}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            判分并下一句
          </button>
        ) : (
          <button
            onClick={() => next(Math.round(result.score * 100))}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground"
          >
            下一句
          </button>
        )}
      </div>
    </ChallengeShell>
  );
}
