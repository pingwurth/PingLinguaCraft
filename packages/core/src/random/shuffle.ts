/**
 * 种子洗牌（Fisher-Yates + 可复现伪随机）
 *
 * 用途：听写「选词拼句」的词块乱序必须可复现 —— 同一 (种子, 句子) 在重试/刷新后
 * 呈现同一排列（计划验证要求：dictation determinism, seeded shuffle）。
 * 采用 mulberry32：体积极小、分布足够均匀、跨平台结果一致（JS number 语义稳定）。
 */

/**
 * mulberry32 伪随机数生成器（返回 [0,1) 函数）
 * @param seed 种子（任意整数；字符串种子请先用 hashSeed 转换）
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 字符串种子 → 32 位整数（FNV-1a，稳定跨运行）
 * @param s 种子字符串
 */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 种子洗牌（Fisher-Yates）：同一 (数组, 种子) 恒得同一排列；不修改原数组
 * @param items 待洗牌数组
 * @param seed 种子（数字或字符串）
 * @returns 洗牌后的新数组
 */
export function seededShuffle<T>(items: readonly T[], seed: number | string): T[] {
  const rand = typeof seed === 'number' ? mulberry32(seed) : mulberry32(hashSeed(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * 种子采样（不放回）：同一 (数组, k, 种子) 恒得同一批结果；不修改原数组。
 * 只做 k 次随机交换（部分 Fisher-Yates），不做全量洗牌——大池子只取少数
 * 几项（如复习页从 200 词干扰池取 3 项）时避免整池洗牌的开销。
 * @param items 待采样数组
 * @param k     采样数量（超出数组长度时取全部）
 * @param seed  种子（数字或字符串）
 * @returns 采样结果（保持确定性）
 */
export function seededPick<T>(items: readonly T[], k: number, seed: number | string): T[] {
  const rand = typeof seed === 'number' ? mulberry32(seed) : mulberry32(hashSeed(seed));
  const out = [...items];
  const n = Math.min(k, out.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (out.length - i));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out.slice(0, n);
}
