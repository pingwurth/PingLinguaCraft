/**
 * 种子采样测试：seededPick 的确定性、不放回与 k 边界归一化
 *（seededShuffle 的确定性已有 m2.test.ts 覆盖，此处专测采样）
 */

import { describe, expect, it } from 'vitest';
import { seededPick } from '../src/random/shuffle';

/** 0..19 的采样池 */
const pool = Array.from({ length: 20 }, (_, i) => i);

describe('seededPick（种子采样）', () => {
  it('同 (数组, k, 种子) 恒得同一结果（可复现）', () => {
    expect(seededPick(pool, 3, 'seed-1')).toEqual(seededPick(pool, 3, 'seed-1'));
    expect(seededPick(pool, 3, 42)).toEqual(seededPick(pool, 3, 42));
  });

  it('不放回：结果无重复', () => {
    const picked = seededPick(pool, 10, 'no-replace');
    expect(new Set(picked).size).toBe(10);
  });

  it('不修改原数组', () => {
    const before = [...pool];
    seededPick(pool, 5, 'immutable');
    expect(pool).toEqual(before);
  });

  it('k 超出数组长度：取全部', () => {
    expect(seededPick([1, 2, 3], 10, 'x')).toHaveLength(3);
  });

  it('k 边界归一化：0 / 负数 / NaN → 空结果；小数向下取整', () => {
    expect(seededPick(pool, 0, 'x')).toEqual([]);
    expect(seededPick(pool, -1, 'x')).toEqual([]); // 负索引 slice 语义必须被拦
    expect(seededPick(pool, Number.NaN, 'x')).toEqual([]);
    expect(seededPick(pool, 3.7, 'x')).toHaveLength(3);
    expect(seededPick(pool, 0.9, 'x')).toEqual([]);
  });

  it('不同种子产出（大概率）不同组合', () => {
    const a = seededPick(pool, 5, 'a');
    const b = seededPick(pool, 5, 'b');
    expect(a).not.toEqual(b);
  });
});
