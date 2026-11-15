/**
 * FSRS-6 间隔重复算法（Free Spaced Repetition Scheduler v6）
 *
 * 与 ts-fsrs 6.x 参考实现对齐（单测逐步比对：同参数同输入 → 同输出；
 * 对齐条件 learning_steps=[] + enable_short_term=false，即 LongTermScheduler 语义）：
 * - 21 个默认权重 w[0..20]，w[20] 为衰减（decay = -w[20]）
 * - factor = e^(ln0.9/decay) - 1（R(t,S)=0.9 ⇔ t=S）
 * - 难度更新带线性阻尼（Δd·(10-d)/9）与均值回归（w[7]，锚点 D₀(4)），
 *   init_difficulty / mean_reversion 均 roundTo(…,8)（与参考逐位一致）
 * - 遗忘稳定性用 w[14]（与回忆稳定性的 w[10] 分离——FSRS-6 变更），且不超过原稳定性
 * - 间隔计算：四档（again/hard/good/easy）各算基础间隔（≥1 天）后施加参考
 *   calculateScheduleDays 单调链——后一档 ≥ 前一档+1，统一封顶 36500 天；
 *   新卡与复习路径同链（参考两路径均走四档全链）
 * - elapsed 按参考 dateDiffInDays 语义：UTC 日历日差（floor），非小数天
 * - 新卡首答不计 lapse（参考仅 Review 态的 again 才 +1）
 * - 当日内重练不经调度（短时调度 w[17..19] 未实现，按天粒度复习）：
 *   「忘了」的词由复习页「再练遗忘词」入口重学，不写 FSRS 状态
 * - 全程 roundTo(…, 8) 与钳制（S∈[0.001, 36500]，D∈[1,10]）
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

/** 一天的毫秒数（elapsed 日历日差与 due 推算共用，保证两处口径一致） */
const MS_PER_DAY = 86_400_000;

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
 * @param elapsedDays 距上次复习天数（UTC 日历日）
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
 * 新卡初始难度原值（roundTo(…,8)，未钳制——参考 init_difficulty 的返回即取整值，
 * 均值回归锚点用的也是这个取整值）
 */
export function rawInitDifficulty(rating: FSRSRating, w: readonly number[]): number {
  return roundTo(w[4]! - Math.exp((rating - 1) * w[5]!) + 1, 8);
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
 * 均值回归（向新卡难度基准收敛；结果 roundTo(…,8)，与参考一致）
 */
function meanReversion(init: number, current: number, w: readonly number[]): number {
  return roundTo(w[7]! * init + (1 - w[7]!) * current, 8);
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
 * （参考在关闭短时调度时为 clamp(roundTo(S_old,8), S_min, S_after_fail)）
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
  return clamp(roundTo(stability, 8), S_MIN, forget);
}

/**
 * 稳定性 → 基础间隔天数（≥1）
 */
export function stabilityToInterval(stability: number, requestRetention: number, w: readonly number[] = DEFAULT_W): number {
  const { decay, factor } = decayFactor(w);
  return Math.max(Math.round((stability / factor) * (Math.pow(requestRetention, 1 / decay) - 1)), 1);
}

/**
 * 四档间隔施加单调链（对齐参考 calculateScheduleDays）：
 * 后一档 ≥ 前一档 + 1 天（前档为 0 天时保持 ≥0——本实现基础间隔恒 ≥1，
 * 0 分支仅为与参考逐位同构而保留），全部封顶 maxInterval（参考默认 36500，
 * 恰与 S_MAX 同值）。输入不修改。
 * @param bases       各档基础间隔 [again, hard, good, easy]
 * @param maxInterval 间隔上限（天）
 */
function chainIntervals(
  bases: readonly [number, number, number, number],
  maxInterval: number = S_MAX
): [number, number, number, number] {
  // 输入恒 ≥1（stabilityToInterval 内部 Math.max(…,1)），参考实现里
  // 「前档为 0 天则保持 ≥0」的分支在此不可达，直接取前档+1
  const first = Math.min(bases[0]!, maxInterval);
  const second = Math.min(Math.max(bases[1]!, first + 1), maxInterval);
  const third = Math.min(Math.max(bases[2]!, second + 1), maxInterval);
  return [first, second, third, Math.min(Math.max(bases[3]!, third + 1), maxInterval)];
}

/**
 * UTC 日历日差（对齐参考 dateDiffInDays）：按两时刻各自所在 UTC 日期求整日差
 * （与参考用 getUTCFullYear/getUTCMonth/getUTCDate 构造 UTC 日再作差逐位等价，
 * 均为 UTC 口径、与时区无关）。
 * 例：周日 22:00 复习 → 周三 07:00 再复习 = 3 个日历日（实际只过 2.375 天）；
 * 同日多次复习 = 0。
 * @param lastMs 上次复习时刻（epoch 毫秒）
 * @param nowMs  本次复习时刻（epoch 毫秒）
 */
export function calendarDaysBetween(lastMs: number, nowMs: number): number {
  return Math.floor(nowMs / MS_PER_DAY) - Math.floor(lastMs / MS_PER_DAY);
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

  if (prev === null || prev.reps === 0) {
    // 新卡（参考 Learning 首答）：四档初始稳定性 → 基础间隔 → 四档全链；
    // 首答不计 lapse（参考 newState 不加 lapse；保留历史 lapses 不抹零）
    const chained = chainIntervals([
      stabilityToInterval(initStability(1, w), retention, w),
      stabilityToInterval(initStability(2, w), retention, w),
      stabilityToInterval(initStability(3, w), retention, w),
      stabilityToInterval(initStability(4, w), retention, w),
    ]);
    const scheduledDays = chained[rating - 1]!;
    return {
      state: {
        stability: initStability(rating, w),
        difficulty: initDifficulty(rating, w),
        lastReviewMs: nowMs,
        reps: 1,
        lapses: prev?.lapses ?? 0,
      },
      scheduledDays,
      dueMs: nowMs + scheduledDays * MS_PER_DAY,
    };
  }

  // 复习（参考 Review 态）：四档各算新稳定性（共享同一可提取性 r）→
  // 各档基础间隔 → 四档全链 → 取本档间隔
  // elapsed 取 UTC 日历日差（与参考 dateDiffInDays 一致；钳 0 防时钟回拨出负值）
  const elapsedDays = Math.max(0, calendarDaysBetween(prev.lastReviewMs, nowMs));
  const r = forgettingCurve(elapsedDays, prev.stability, w);
  const stabilities: readonly [number, number, number, number] = [
    nextForgetStability(prev.stability, prev.difficulty, r, w),
    nextRecallStability(prev.stability, prev.difficulty, r, 2, w),
    nextRecallStability(prev.stability, prev.difficulty, r, 3, w),
    nextRecallStability(prev.stability, prev.difficulty, r, 4, w),
  ];
  const chained = chainIntervals([
    stabilityToInterval(stabilities[0]!, retention, w),
    stabilityToInterval(stabilities[1]!, retention, w),
    stabilityToInterval(stabilities[2]!, retention, w),
    stabilityToInterval(stabilities[3]!, retention, w),
  ]);

  const scheduledDays = chained[rating - 1]!;
  return {
    state: {
      stability: stabilities[rating - 1]!,
      difficulty: nextDifficulty(prev.difficulty, rating, w),
      lastReviewMs: nowMs,
      reps: prev.reps + 1,
      lapses: prev.lapses + (rating === 1 ? 1 : 0),
    },
    scheduledDays,
    dueMs: nowMs + scheduledDays * MS_PER_DAY,
  };
}
