/**
 * FSRS-6 间隔重复算法（Free Spaced Repetition Scheduler v6）
 *
 * 与 ts-fsrs 6.x 参考实现逐位对齐（单测比对：同参数同输入 → 同输出）：
 * - 21 个默认权重 w[0..20]，w[20] 为可训练衰减（decay = -w[20]）
 * - factor = e^(ln0.9/decay) - 1（R(t,S)=0.9 ⇔ t=S）
 * - 难度更新带线性阻尼（Δd·(10-d)/9）与均值回归（w[7]）
 * - 遗忘稳定性用 w[14]（与回忆稳定性的 w[10] 分离——FSRS-6 变更）
 * - 间隔恒 ≥1 天（含 again；当日内重练由 UI 层引导，算法层与参考一致）
 * - 全程 roundTo(…, 8) 与钳制（S∈[0.001, 36500]，D∈[1,10]）
 * 未实现：短时调度（same-day short-term，w[17..19]）——本产品按天粒度复习，
 * 与参考测试对齐时同样关闭 enable_short_term。
 */

/** FSRS-6 官方默认权重（21 个；w[20] 为衰减权重） */
export const DEFAULT_W: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
];

/** 稳定性/难度边界 */
export const S_MIN = 0.001;
export const S_MAX = 36500;

/** 评分（1~4） */
export type FSRSRating = 1 | 2 | 3 | 4;

/** 记忆状态（卡片的可持久化部分） */
export interface FSRSState {
  stability: number;
  difficulty: number;
  lastReviewMs: number;
  reps: number;
  lapses: number;
}

/** 一次复习后的调度结果 */
export interface FSRSResult {
  state: FSRSState;
  /** 间隔天数（≥1） */
  scheduledDays: number;
  /** 下次到期时间（epoch 毫秒） */
  dueMs: number;
}

/** 调度参数 */
export interface FSRSOptions {
  /** 权重（默认官方 21 参） */
  w?: readonly number[];
  /** 目标保留率（默认 0.9） */
  requestRetention?: number;
}

/** 8 位小数取整（与参考实现逐位一致的关键） */
function roundTo(x: number, digits = 8): number {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

/** 钳制 */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * 由衰减权重推 (decay, factor)
 * @param w 权重
 */
export function decayFactor(w: readonly number[]): { decay: number; factor: number } {
  const decay = -w[20]!;
  const factor = roundTo(Math.exp(Math.log(0.9) / decay) - 1, 8);
  return { decay, factor };
}

/**
 * 可提取性（还能记住的概率）
 * @param elapsedDays 距上次复习天数
 * @param stability   稳定性
 * @param w           权重
 */
export function forgettingCurve(elapsedDays: number, stability: number, w: readonly number[] = DEFAULT_W): number {
  const { decay, factor } = decayFactor(w);
  return roundTo(Math.pow(1 + (factor * elapsedDays) / stability, decay), 8);
}

/**
 * 新卡初始稳定性
 */
export function initStability(rating: FSRSRating, w: readonly number[]): number {
  return clamp(w[rating - 1]!, S_MIN, S_MAX);
}

/**
 * 新卡初始难度（未钳制原值——参考实现中均值回归的锚点用原值，仅卡片落库时钳制）
 */
export function rawInitDifficulty(rating: FSRSRating, w: readonly number[]): number {
  return w[4]! - Math.exp((rating - 1) * w[5]!) + 1;
}

/**
 * 新卡初始难度（钳制 1~10）
 */
export function initDifficulty(rating: FSRSRating, w: readonly number[]): number {
  return clamp(rawInitDifficulty(rating, w), 1, 10);
}

/**
 * 线性阻尼（难度增量随当前难度衰减）
 */
function linearDamping(deltaD: number, oldD: number): number {
  return roundTo((deltaD * (10 - oldD)) / 9, 8);
}

/**
 * 均值回归（向新卡难度基准收敛）
 */
function meanReversion(init: number, current: number, w: readonly number[]): number {
  return w[7]! * init + (1 - w[7]!) * current;
}

/**
 * 复习后难度更新（线性阻尼 + 均值回归；回归锚为未钳制的 D₀(4)，结果钳制 1~10）
 */
export function nextDifficulty(difficulty: number, rating: FSRSRating, w: readonly number[]): number {
  const deltaD = -w[6]! * (rating - 3);
  const next = difficulty + linearDamping(deltaD, difficulty);
  return clamp(meanReversion(rawInitDifficulty(4, w), next, w), 1, 10);
}

/**
 * 回忆成功后的稳定性
 */
export function nextRecallStability(
  stability: number,
  difficulty: number,
  retrievability: number,
  rating: FSRSRating,
  w: readonly number[]
): number {
  const hardPenalty = rating === 2 ? w[15]! : 1;
  const easyBound = rating === 4 ? w[16]! : 1;
  const s =
    stability *
    (1 +
      Math.exp(w[8]!) * (11 - difficulty) * Math.pow(stability, -w[9]!) *
      (Math.exp((1 - retrievability) * w[10]!) - 1) *
      hardPenalty * easyBound);
  return roundTo(clamp(s, S_MIN, S_MAX), 8);
}

/**
 * 遗忘后的稳定性（w[14] 为 FSRS-6 的遗忘衰减项）—— 且不超过原稳定性
 */
export function nextForgetStability(
  stability: number,
  difficulty: number,
  retrievability: number,
  w: readonly number[]
): number {
  const sAfterFail =
    w[11]! * Math.pow(difficulty, -w[12]!) * (Math.pow(stability + 1, w[13]!) - 1) *
    Math.exp((1 - retrievability) * w[14]!);
  const forget = roundTo(clamp(sAfterFail, S_MIN, S_MAX), 8);
  // 遗忘不得使稳定性升高：以原稳定性为上界
  return clamp(stability, S_MIN, forget);
}

/**
 * 稳定性 → 基础间隔天数（≥1）
 */
export function stabilityToInterval(stability: number, requestRetention: number, w: readonly number[] = DEFAULT_W): number {
  const { decay, factor } = decayFactor(w);
  return Math.max(Math.round((stability / factor) * (Math.pow(requestRetention, 1 / decay) - 1)), 1);
}

/**
 * 各档间隔施加严格递增链（与参考实现一致：后一档 ≥ 前一档 + 1 天）
 * @param bases 各档基础间隔 [again, hard, good, easy]（新卡场景四档全链；
 *              复习场景传 [again 独立, hard, good, easy]，chainFrom=1 只链后三档）
 */
function orderIntervals(bases: [number, number, number, number], chainFrom: 0 | 1): [number, number, number, number] {
  const out = [...bases] as [number, number, number, number];
  for (let i = Math.max(1, chainFrom); i < 4; i++) {
    out[i] = Math.max(out[i]!, out[i - 1]! + 1);
  }
  return out;
}

/**
 * FSRS 调度主入口：给定状态与评分，产出新状态与下次到期
 * @param prev    之前状态（新卡传 null）
 * @param rating  本次评分
 * @param nowMs   当前时间
 * @param opts    参数
 */
export function fsrsSchedule(
  prev: FSRSState | null,
  rating: FSRSRating,
  nowMs: number,
  opts: FSRSOptions = {}
): FSRSResult {
  const w = opts.w ?? DEFAULT_W;
  const retention = opts.requestRetention ?? 0.9;

  let newStability: number;
  let newDifficulty: number;

  if (prev === null || prev.reps === 0) {
    // 新卡：四档初始稳定性 → 基础间隔 → 全链排序（与参考 Learning 路径一致）
    const bases = orderIntervals(
      [1, 2, 3, 4].map((g) =>
        stabilityToInterval(initStability(g as FSRSRating, w), retention, w)
      ) as [number, number, number, number],
      0
    );
    newStability = initStability(rating, w);
    newDifficulty = initDifficulty(rating, w);
    const scheduledDaysNew = bases[rating - 1]!;
    return {
      state: {
        stability: newStability,
        difficulty: newDifficulty,
        lastReviewMs: nowMs,
        reps: 1,
        lapses: rating === 1 ? 1 : 0,
      },
      scheduledDays: scheduledDaysNew,
      dueMs: nowMs + scheduledDaysNew * 86_400_000,
    };
  }

  // 复习：难度 + 本档稳定性 → 间隔（参考实现的 Review 态不做档间链式约束）
  const elapsedDays = Math.max(0, (nowMs - prev.lastReviewMs) / 86_400_000);
  const r = forgettingCurve(elapsedDays, prev.stability, w);
  newDifficulty = nextDifficulty(prev.difficulty, rating, w);
  if (rating === 1) {
    newStability = nextForgetStability(prev.stability, prev.difficulty, r, w);
  } else {
    newStability = nextRecallStability(prev.stability, prev.difficulty, r, rating, w);
  }
  const scheduledDays = stabilityToInterval(newStability, retention, w);
  const dueMs = nowMs + scheduledDays * 86_400_000;

  return {
    state: {
      stability: newStability,
      difficulty: newDifficulty,
      lastReviewMs: nowMs,
      reps: (prev?.reps ?? 0) + 1,
      lapses: (prev?.lapses ?? 0) + (rating === 1 ? 1 : 0),
    },
    scheduledDays,
    dueMs,
  };
}
