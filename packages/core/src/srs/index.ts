/**
 * SRS（间隔重复）模块出口 —— FSRS-6 完整实现（M4）
 *
 * fsrs.ts 是算法本体（与 ts-fsrs 参考实现单测对齐）；
 * 此处保留面向业务的轻量门面（评分枚举 + 业务状态映射）。
 */

export {
  DEFAULT_W,
  S_MIN,
  S_MAX,
  decayFactor,
  rawInitDifficulty,
  forgettingCurve,
  initStability,
  initDifficulty,
  nextDifficulty,
  nextRecallStability,
  nextForgetStability,
  stabilityToInterval,
  calendarDaysBetween,
  fsrsSchedule,
} from './fsrs';
export type { FSRSRating, FSRSState, FSRSResult, FSRSOptions } from './fsrs';

/** 业务评分（UI 文案友好形态） */
export type SRating = 'again' | 'hard' | 'good' | 'easy';

/** 业务评分 → FSRS 1~4 */
export function toFSRSRating(r: SRating): 1 | 2 | 3 | 4 {
  const map: Record<SRating, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 };
  return map[r];
}

/**
 * 复习次数与最近评分 → 业务学习状态（words.status）
 * @param reps   累计复习次数
 * @param rating 最近一次评分
 */
export function wordStatus(reps: number, rating: SRating): 'new' | 'learning' | 'review' | 'mastered' {
  if (reps === 0) return 'new';
  if (rating === 'again') return 'learning';
  if (reps >= 8) return 'mastered';
  if (reps >= 2) return 'review';
  return 'learning';
}
