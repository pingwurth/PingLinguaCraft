/**
 * FSRS-6 对齐测试：与 ts-fsrs 参考实现比对（同参数同输入 → 同输出）
 *
 * ts-fsrs 仅作为 devDependency 测试参照，不进入运行时（core 保持零运行时依赖）。
 * 覆盖：新卡四档、连续复习序列（好/混评）、遗忘路径、间隔换算。
 */

import { describe, expect, it } from 'vitest';
import { fsrs, Rating, State, createEmptyCard } from 'ts-fsrs';
import { DEFAULT_W, fsrsSchedule, forgettingCurve, stabilityToInterval } from '../src/srs/fsrs';

/** 官方默认权重注入 ts-fsrs（保证两边同参）。
 *  learning_steps 置空：禁用新卡短期学习步（10 分钟内重见），让参考实现
 *  与本实现同语义——第一次复习即进入长期间隔调度，公式可直接比对。 */
const refFsrs = fsrs({
  w: [...DEFAULT_W],
  request_retention: 0.9,
  enable_fuzz: false,
  learning_steps: [],
  enable_short_term: false,
});

/** 参考实现 repeat() 的取值助手（返回按评分键控的映射） */
function refPick(entries: ReturnType<typeof refFsrs.repeat>, rating: Rating) {
  const e = (entries as unknown as Record<number, { card: ReturnType<typeof createEmptyCard> & { scheduled_days: number } }>)[rating];
  return e;
}

const DAY = 86_400_000;

describe('FSRS-6 与 ts-fsrs 对齐', () => {
  it('新卡四档：稳定性/难度/间隔一致', () => {
    const now = new Date('2026-11-15T10:00:00Z');
    const entries = refFsrs.repeat(createEmptyCard(now), now);
    for (const rating of [1, 2, 3, 4] as const) {
      const mine = fsrsSchedule(null, rating, now.getTime());
      const picked = refPick(entries, rating as Rating)!;
      expect(mine.state.stability).toBeCloseTo(picked.card.stability, 6);
      expect(mine.state.difficulty).toBeCloseTo(picked.card.difficulty, 6);
      expect(mine.scheduledDays).toBe(picked.card.scheduled_days);
    }
  });

  it('连续序列 good×3 → 再混 hard/easy（各步一致）', () => {
    let now = new Date('2026-11-15T10:00:00Z');
    let refCard = createEmptyCard(now);
    let minePrev: ReturnType<typeof fsrsSchedule> | null = null;
    const ratings: Array<1 | 2 | 3 | 4> = [3, 3, 3, 2, 4, 3];
    for (const rating of ratings) {
      const mine = fsrsSchedule(minePrev ? minePrev.state : null, rating, now.getTime());
      const picked = refPick(refFsrs.repeat(refCard, now), rating as Rating)!;
      // 容差 1e-4：两实现的浮点运算顺序差异累积 ~1e-8（第 6 步观测 3e-6），
      // 远低于业务精度；间隔允许 ±1 天（长间隔的舍入边界抖动）
      expect(mine.state.stability).toBeCloseTo(picked.card.stability, 4);
      expect(mine.state.difficulty).toBeCloseTo(picked.card.difficulty, 4);
      expect(Math.abs(mine.scheduledDays - picked.card.scheduled_days)).toBeLessThanOrEqual(1);
      minePrev = mine;
      // 两边都按调度间隔推进到下次复习时刻
      const stepDays = Math.max(1, picked.card.scheduled_days);
      now = new Date(now.getTime() + stepDays * DAY);
      refCard = picked.card;
    }
  });

  it('遗忘路径（again）：稳定性缩短、间隔 ≥1 天、lapses+1', () => {
    const now = new Date('2026-11-15T10:00:00Z');
    const first = fsrsSchedule(null, 3, now.getTime());
    const later = new Date(now.getTime() + 3 * DAY);
    const second = fsrsSchedule(first.state, 1, later.getTime());
    expect(second.state.stability).toBeLessThan(first.state.stability);
    expect(second.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(second.state.lapses).toBe(1);
    // 与参考实现一致
    const e1 = refPick(refFsrs.repeat(createEmptyCard(now), now), 3)!;
    const e2 = refPick(refFsrs.repeat(e1.card as never, later), 1)!;
    expect(second.state.stability).toBeCloseTo(e2.card.stability, 6);
  });

  it('遗忘曲线：t=S 时 R=0.9', () => {
    expect(forgettingCurve(10, 10)).toBeCloseTo(0.9, 6);
  });

  it('间隔换算：S/FACTOR·(R^(1/DECAY)-1) 取整', () => {
    expect(stabilityToInterval(10, 0.9)).toBe(10);
    // 高保留率 → 更短间隔
    expect(stabilityToInterval(10, 0.95)).toBeLessThan(10);
  });
});
