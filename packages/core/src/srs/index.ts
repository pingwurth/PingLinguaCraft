/**
 * SRS（间隔重复）算法模块 —— M4 里程碑实现
 *
 * 计划采用 FSRS-5 算法（调度参数与参考实现向量在 M4 单元测试中对齐）。
 * 当前先落地数据类型骨架，供 schema 与 UI 预留字段使用。
 */

/**
 * 复习评分（FSRS 标准 1~4）
 * - again 忘记 / hard 困难 / good 良好 / easy 轻松
 */
export type SRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * SRS 卡片调度状态（对应 srs_cards 表字段）
 */
export interface SRSCardState {
  /** 记忆稳定性（天）：越高越牢 */
  stability: number;
  /** 难度（0~10）：越高越难 */
  difficulty: number;
  /** 下次到期时间（epoch 毫秒） */
  dueMs: number;
  /** 已复习次数 */
  reps: number;
  /** 遗忘次数 */
  lapses: number;
  /** 上次复习时间（epoch 毫秒） */
  lastReviewMs: number | null;
}

/**
 * 单次复习后的调度结果
 */
export interface SRScheduleResult {
  /** 更新后的卡片状态 */
  state: SRSCardState;
  /** 本次调度出的间隔（天） */
  scheduledDays: number;
}

/**
 * FSRS 调度函数：给定卡片状态与评分，计算下一次复习安排
 * @param card    当前卡片状态（新卡传 null）
 * @param rating  本次评分
 * @param nowMs   当前时间（epoch 毫秒）
 * @returns 更新后的状态与间隔天数
 * @todo M4 里程碑：按 FSRS-5 公式实现，并以官方参考向量做单元测试
 */
export function schedule(
  card: SRSCardState | null,
  rating: SRating,
  nowMs: number
): SRScheduleResult {
  // 占位实现：固定间隔梯度，保证 schema/UI 可以先行联调；M4 替换为 FSRS-5
  const baseDays = { again: 0, hard: 1, good: 3, easy: 7 }[rating];
  const prevDays = card ? Math.max(1, (card.dueMs - (card.lastReviewMs ?? card.dueMs)) / 86_400_000) : 0;
  const scheduledDays = card
    ? Math.max(baseDays, Math.round(prevDays * (rating === 'again' ? 0 : rating === 'hard' ? 1.2 : rating === 'good' ? 2.2 : 3.5)))
    : baseDays;
  const dueMs = nowMs + scheduledDays * 86_400_000;
  return {
    state: {
      stability: card ? card.stability * (1 + scheduledDays / 30) : scheduledDays,
      difficulty: card ? card.difficulty : 5,
      dueMs,
      reps: (card?.reps ?? 0) + 1,
      lapses: (card?.lapses ?? 0) + (rating === 'again' ? 1 : 0),
      lastReviewMs: nowMs,
    },
    scheduledDays,
  };
}
