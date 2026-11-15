/**
 * FSRS-6 对齐测试：与 ts-fsrs 参考实现比对（同参数同输入 → 同输出）
 *
 * ts-fsrs 仅作为 devDependency 测试参照，不进入运行时（core 保持零运行时依赖）。
 * 覆盖：新卡四档、连续复习序列（好/混评/遗忘链）、非整时刻复习（UTC 日历日）、
 * 间隔换算。
 *
 * 对齐条件 learning_steps=[] + enable_short_term=false 时参考输出确定
 * （enable_fuzz=false），因此浮点量用 toBeCloseTo(…, 8)（即 5e-9 内，等价于
 * 两边同走 roundTo(…,8) 后的逐位一致），间隔天数与 lapses 用 toBe 精确比对——
 * 容差只应留给确证的浮点顺序差异，±1 天级回归必须在测试下现形。
 */

import { describe, expect, it } from 'vitest';
import { fsrs, Rating, createEmptyCard } from 'ts-fsrs';
import { calendarDaysBetween, DEFAULT_W, fsrsSchedule, forgettingCurve, stabilityToInterval } from '../src/srs/fsrs';

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

/** 一步对齐断言：稳定性/难度（8 位小数内）、间隔天数、lapses 全部一致 */
function expectAligned(
  mine: ReturnType<typeof fsrsSchedule>,
  picked: NonNullable<ReturnType<typeof refPick>>
) {
  expect(mine.state.stability).toBeCloseTo(picked.card.stability, 8);
  expect(mine.state.difficulty).toBeCloseTo(picked.card.difficulty, 8);
  expect(mine.scheduledDays).toBe(picked.card.scheduled_days);
  expect(mine.state.lapses).toBe(picked.card.lapses);
}

/**
 * 参考与本实现按同一时钟推进同一评分序列，逐步比对
 * @param ratings 评分序列
 * @param startAt 首次复习时刻
 */
function runAlignedSequence(ratings: Array<1 | 2 | 3 | 4>, startAt = new Date('2026-11-15T10:00:00Z')) {
  const DAY = 86_400_000;
  let now = startAt;
  let refCard = createEmptyCard(now);
  let minePrev: ReturnType<typeof fsrsSchedule> | null = null;
  for (const rating of ratings) {
    const mine = fsrsSchedule(minePrev ? minePrev.state : null, rating, now.getTime());
    const picked = refPick(refFsrs.repeat(refCard, now), rating as Rating)!;
    expectAligned(mine, picked);
    // 两边都按参考调度间隔推进到下次复习时刻（保持同一时钟）
    const stepDays = Math.max(1, picked.card.scheduled_days);
    now = new Date(now.getTime() + stepDays * DAY);
    refCard = picked.card;
    minePrev = mine;
  }
}

describe('FSRS-6 与 ts-fsrs 对齐', () => {
  it('新卡四档：稳定性/难度/间隔一致，且首答不计 lapse', () => {
    const now = new Date('2026-11-15T10:00:00Z');
    const entries = refFsrs.repeat(createEmptyCard(now), now);
    for (const rating of [1, 2, 3, 4] as const) {
      const mine = fsrsSchedule(null, rating, now.getTime());
      const picked = refPick(entries, rating as Rating)!;
      expectAligned(mine, picked);
      // 新卡任何档位都不计 lapse（参考 newState 不加，仅 Review 态 again 才 +1）
      expect(mine.state.lapses).toBe(0);
    }
  });

  it('连续序列 good×3 → 再混 hard/easy（各步一致）', () => {
    runAlignedSequence([3, 3, 3, 2, 4, 3]);
  });

  it('遗忘链 good → again×3 → hard×3：低稳定度区逐位一致（回归：曾缺单调链少排 1 天）', () => {
    runAlignedSequence([3, 1, 1, 1, 2, 2, 2]);
  });

  it('非整时刻复习：elapsed 按 UTC 日历日（回归：曾用小数天偏离参考）', () => {
    // 周日 22:00 首答 good → 下次复习隔 3 个日历日的周三 07:00（实际只过 2.375 天）
    runAlignedSequence([3, 2, 1, 3], new Date('2026-11-15T22:00:00Z'));
    expect(calendarDaysBetween(Date.UTC(2026, 10, 15, 22, 0), Date.UTC(2026, 10, 18, 7, 0))).toBe(3);
    expect(calendarDaysBetween(Date.UTC(2026, 10, 15, 1, 0), Date.UTC(2026, 10, 15, 23, 0))).toBe(0);
  });

  it('遗忘路径（again）：稳定性缩短、间隔 ≥1 天、lapses+1', () => {
    const now = new Date('2026-11-15T10:00:00Z');
    const first = fsrsSchedule(null, 3, now.getTime());
    const later = new Date(now.getTime() + 3 * 86_400_000);
    const second = fsrsSchedule(first.state, 1, later.getTime());
    expect(second.state.stability).toBeLessThan(first.state.stability);
    expect(second.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(second.state.lapses).toBe(1);
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
