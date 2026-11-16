'use client';

/**
 * 九宫格 · 选词拼句玩法（需求 17 玩法一，设计稿 _3 选词排阵）
 *
 * 逐句挑战：词块打乱（种子确定），点选按序复原；可校验重试；
 * 本句通过（或放弃）→ 下一句；总成绩 = 首次正确率。
 */

import { useEffect, useMemo, useState } from 'react';
import { extractWords, seededShuffle } from '@pinglc/core';
import { api } from '@/lib/api';
import type { CueDTO } from '@/lib/api';
import { ChallengeShell, useChallengeRun } from './ChallengeShell';

/**
 * 九宫格玩法
 */
export function GridMode({
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
  const [attempt, setAttempt] = useState(0); // 重试计数（成绩递减）
  const [picked, setPicked] = useState<number[]>([]);
  const [checked, setChecked] = useState<null | boolean>(null);

  const words = useMemo(() => (cue ? extractWords(cue.textEn) : []), [cue]);
  const seedBase = run.current;
  const tiles = useMemo(
    () => (cue ? seededShuffle(words, `${cue.materialId}-grid-${cue.id}-${seedBase}`) : []),
    [cue, words, seedBase]
  );

  // 换句下标（解构为基本值供 effect 依赖；run 每次渲染都是新对象）
  const { current: runCurrent } = run;
  // 换句即清本地作答态：「再来一轮」回到第 0 句时，旧 picked 的下标可能超出
  // 新句词块数（旧实现 tiles[ti]! 直接崩溃）、checked 残留会锁死词块池
  useEffect(() => {
    setPicked([]);
    setChecked(null);
    setAttempt(0);
  }, [runCurrent]);

  const nextSentence = (score: number) => {
    setPicked([]);
    setChecked(null);
    setAttempt(0);
    run.advance(score);
    void submitScore(run.scores.length + 1, score);
  };

  /** 成绩回写（闯关 API 取最高，最后统一提交亦可；逐句轻量提交省心）。
   *  经 api() 统一错误契约，失败告警不静默——成绩丢失至少在控制台可见 */
  const submitScore = async (count: number, lastScore: number) => {
    if (count >= cues.length) {
      const total = [...run.scores, lastScore];
      const avg = Math.round(total.reduce((a, b) => a + b, 0) / total.length);
      await api(`/api/materials/${materialId}/challenge`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'grid', score: avg }),
      }).catch((err: unknown) => console.warn('闯关成绩上报失败（不影响本轮）', err));
    }
  };

  if (!cue) return null;

  // 空值兜底而非裸断言：换句瞬间 picked 与新 tiles 短暂错位时不崩溃
  const correct =
    picked.length === words.length &&
    picked.every((ti, i) => (tiles[ti] ?? '').toLowerCase() === (words[i] ?? '').toLowerCase());

  return (
    <ChallengeShell
      cues={cues}
      title="九宫格 · 选词拼句"
      current={run.current}
      onExit={onExit}
      finished={run.finished}
      finalScore={run.scores.length ? Math.round(run.scores.reduce((a, b) => a + b, 0) / run.scores.length) : null}
      onRestart={run.restart}
    >
      {/* 中文提示（有译文时辅助理解） */}
      {cue.textZh && <p className="text-sm text-muted-foreground">{cue.textZh}</p>}

      {/* 拼装槽 */}
      <div className="deckle flex min-h-16 flex-wrap items-center gap-1.5 rounded-md border border-dashed bg-card p-3">
        {picked.length === 0 && <span className="text-xs text-muted-foreground">按正确顺序点选下方词块…</span>}
        {picked.map((ti, pos) => (
          <button
            key={`${ti}-${pos}`}
            disabled={checked !== null}
            onClick={() => setPicked(picked.filter((_, p) => p !== pos))}
            className={`deckle rounded border bg-background px-2.5 py-1.5 font-serif text-sm ${
              checked === true ? ((tiles[ti] ?? '').toLowerCase() === (words[pos] ?? '').toLowerCase() ? 'border-secondary text-secondary' : 'border-destructive text-destructive') : ''
            }`}
          >
            {tiles[ti]}
          </button>
        ))}
      </div>

      {/* 词块池（移动 3 列网格，呼应「九宫格」） */}
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-5">
        {tiles.map((w, ti) => (
          <button
            key={ti}
            disabled={picked.includes(ti) || checked !== null}
            onClick={() => setPicked([...picked, ti])}
            className="deckle rounded-md border bg-background py-2.5 text-center font-serif text-sm transition-colors hover:bg-accent disabled:opacity-25"
          >
            {w}
          </button>
        ))}
      </div>

      {/* 校验反馈与操作 */}
      {checked !== null && (
        <p className={`rounded-md p-3 text-sm ${checked ? 'bg-secondary/10 text-secondary' : 'bg-destructive/10 text-destructive'}`}>
          {checked ? '✓ 复原正确' : '× 顺序有误（红块处不对）——可重试，重试会降低本句得分'}
        </p>
      )}
      <div className="flex gap-2">
        {checked === null ? (
          <button
            onClick={() => setChecked(correct)}
            disabled={picked.length !== words.length}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            校验（{picked.length}/{words.length}）
          </button>
        ) : checked ? (
          <button onClick={() => nextSentence(Math.max(40, 100 - attempt * 20))} className="flex-1 rounded-md bg-primary py-2.5 text-sm text-primary-foreground">
            下一句
          </button>
        ) : (
          <>
            <button
              onClick={() => {
                setPicked([]);
                setChecked(null);
                setAttempt((a) => a + 1);
              }}
              className="flex-1 rounded-md border border-border py-2.5 text-sm"
            >
              重试本句
            </button>
            <button onClick={() => nextSentence(40)} className="rounded-md border border-border px-4 py-2.5 text-sm text-muted-foreground">
              跳过（40 分）
            </button>
          </>
        )}
      </div>
    </ChallengeShell>
  );
}
