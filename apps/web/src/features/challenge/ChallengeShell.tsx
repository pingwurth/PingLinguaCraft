'use client';

/**
 * 闯关玩法公共外壳：进度条 + 逐句推进 + 完成结算（六玩法共用）
 */

import { useState } from 'react';
import type { CueDTO } from '@/lib/api';

/**
 * 玩法外壳组件
 * @param props.cues 句段列表
 * @param props.title 玩法名
 * @param props.total 总关数（句数）
 * @param props.current 当前句下标
 * @param props.children 玩法体（当前句交互）
 * @param props.onAdvance 下一句（传得分明细由玩法自行累计）
 */
export function ChallengeShell({
  cues,
  title,
  current,
  onExit,
  children,
  finished,
  finalScore,
  onRestart,
}: {
  cues: CueDTO[];
  title: string;
  current: number;
  onExit: () => void;
  children: React.ReactNode;
  finished: boolean;
  finalScore: number | null;
  onRestart: () => void;
}) {
  const total = cues.length;
  return (
    /* 玩法容器 */
    <div className="flex flex-col gap-4">
      {/* 头部：玩法名 + 进度 */}
      <div className="flex items-center gap-3">
        <h3 className="font-serif text-lg">{title}</h3>
        <span className="ml-auto text-xs text-ochre">
          {Math.min(current + 1, total)} / {total} 句
        </span>
      </div>
      {/* 进度条 */}
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${(Math.min(current, total) / Math.max(1, total)) * 100}%` }}
        />
      </div>

      {/* 玩法体 / 结算 */}
      {finished ? (
        <div className="deckle flex flex-col items-center rounded-md border bg-card px-6 py-12 text-center">
          <span className="material-symbols-outlined mb-2 text-4xl text-secondary">military_tech</span>
          <p className="font-serif text-2xl">通关！</p>
          <p className="mt-2 text-sm text-ochre">总成绩 {finalScore ?? '—'} 分</p>
          <div className="mt-5 flex gap-3">
            <button onClick={onRestart} className="rounded-md border border-border px-5 py-2 text-sm">
              再来一轮
            </button>
            <button onClick={onExit} className="rounded-md bg-primary px-5 py-2 text-sm text-primary-foreground">
              返回关卡
            </button>
          </div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * 句推进 Hook：玩法通用状态机（当前句 / 完成 / 成绩累计）
 * @param total 总句数
 * @returns 状态与推进函数
 */
export function useChallengeRun(total: number) {
  const [current, setCurrent] = useState(0);
  const [finished, setFinished] = useState(false);
  /** 逐句得分（0~100） */
  const [scores, setScores] = useState<number[]>([]);

  /** 记录本句得分并推进；最后一句触发完成 */
  const advance = (score: number) => {
    setScores((prev) => [...prev, score]);
    if (current + 1 >= total) {
      setFinished(true);
    } else {
      setCurrent((c) => c + 1);
    }
  };

  /** 平均分（完成时结算用） */
  const average = () =>
    scores.length === 0 ? 0 : Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const restart = () => {
    setCurrent(0);
    setFinished(false);
    setScores([]);
  };

  return { current, finished, scores, advance, average, restart };
}
