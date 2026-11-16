'use client';

/**
 * 全文背诵玩法（需求 17 玩法五）
 *
 * 逐句：提示 = 中文译文 + 英文首字母缩写；凭记忆默写原句；
 * diffSentence 判分 ≥80 过关，可无限重试（过关得分封顶递减）；跳过得 40。
 */

import { useEffect, useMemo, useState } from 'react';
import { diffSentence, extractWords } from '@pinglc/core';
import { api } from '@/lib/api';
import type { CueDTO } from '@/lib/api';
import { ChallengeShell, useChallengeRun } from './ChallengeShell';

/**
 * 全文背诵玩法
 */
export function ReciteMode({
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
  const [attempts, setAttempts] = useState(0);

  // 换句下标（解构为基本值供 effect 依赖；run 每次渲染都是新对象）
  const { current: runCurrent } = run;
  // 换句即清作答态（「再来一轮」restart 只重置状态机，本地作答须随之清理）
  useEffect(() => {
    setTyped('');
    setResult(null);
    setAttempts(0);
  }, [runCurrent]);

  /** 首字母提示（如 "Stay hungry" → "S h"） */
  const hint = useMemo(() => {
    if (!cue) return '';
    return extractWords(cue.textEn)
      .map((w) => w[0]!.toUpperCase())
      .join(' ');
  }, [cue]);

  const next = (score: number) => {
    run.advance(score);
    if (run.current + 1 >= cues.length) {
      const total = [...run.scores, score];
      // 经 api() 统一错误契约，失败告警不静默（结算视图不渲染 children）
      void api(`/api/materials/${materialId}/challenge`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'recite', score: Math.round(total.reduce((a, b) => a + b, 0) / total.length) }),
      }).catch((err: unknown) => console.warn('闯关成绩上报失败（不影响本轮）', err));
    }
  };

  if (!cue) return null;
  const score100 = Math.round((result?.score ?? 0) * 100);

  return (
    <ChallengeShell
      cues={cues}
      title="全文背诵"
      current={run.current}
      onExit={onExit}
      finished={run.finished}
      finalScore={run.scores.length ? Math.round(run.scores.reduce((a, b) => a + b, 0) / run.scores.length) : null}
      onRestart={run.restart}
    >
      {/* 提示卡：中文 + 首字母 */}
      <div className="deckle rounded-md border bg-card p-4">
        <p className="text-sm text-muted-foreground">{cue.textZh ?? '（无译文——凭记忆背诵）'}</p>
        <p className="mt-2 font-mono text-sm tracking-widest text-ochre">{hint}</p>
      </div>

      <textarea
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          setResult(null);
        }}
        placeholder="背诵原句…"
        disabled={!!result}
        className="min-h-24 w-full rounded-md border border-input bg-background p-3 font-serif text-base"
      />

      {result && (
        <div className="flex flex-wrap gap-1.5 rounded-md bg-card p-3">
          {result.items.map((it, i) => (
            <span key={i} className={it.status === 'correct' ? 'text-secondary' : it.status === 'typo' ? 'text-ochre' : 'text-destructive'}>
              {it.target || it.typed}
            </span>
          ))}
          <span className="ml-auto self-center text-xs text-muted-foreground">
            {score100} 分{score100 >= 80 ? ' · 过关' : ' · 未达 80'}
          </span>
        </div>
      )}

      <div className="flex gap-2">
        {!result ? (
          <button
            onClick={() => setResult(diffSentence(cue.textEn, typed))}
            disabled={!typed.trim()}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            校验背诵
          </button>
        ) : score100 >= 80 ? (
          <button onClick={() => next(Math.max(50, score100 - attempts * 10))} className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground">
            下一句
          </button>
        ) : (
          <>
            <button
              onClick={() => {
                setResult(null);
                setAttempts((a) => a + 1);
              }}
              className="flex-1 rounded-md border border-border py-2.5 text-sm"
            >
              再背一次
            </button>
            <button onClick={() => next(40)} className="rounded-md border border-border px-4 py-2.5 text-sm text-muted-foreground">
              跳过（40 分）
            </button>
          </>
        )}
      </div>
    </ChallengeShell>
  );
}
