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
 *
 * current/finished 由 scores.length 派生而非独立 state：advance 从渲染闭包
 * 读 current 的旧实现里，双击或异步回调双推会让两次调用看到同一快照——
 * 跳句、重复计分或错误置 finished。派生 + 完成后拒追加，双推天然无害。
 * @param total 总句数
 * @returns 状态与推进函数
 */
export function useChallengeRun(total: number) {
  /** 逐句得分（0~100）；长度即已推进句数（唯一真值源） */
  const [scores, setScores] = useState<number[]>([]);

  const finished = scores.length >= total;
  /** 当前句下标：未完成时 = 已推进数；完成后收敛在末句（结算视图不索引 cues） */
  const current = Math.min(scores.length, Math.max(0, total - 1));

  /** 记录本句得分并推进；完成后拒绝追加（双推/重放的幂等护栏） */
  const advance = (score: number) => {
    setScores((prev) => (prev.length >= total ? prev : [...prev, score]));
  };

  /** 平均分（完成时结算用） */
  const average = () =>
    scores.length === 0 ? 0 : Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const restart = () => setScores([]);

  return { current, finished, scores, advance, average, restart };
}
