/**
 * M2 练习模式核心逻辑测试：种子洗牌确定性 + 听写比对
 */

import { describe, expect, it } from 'vitest';
import { seededShuffle, hashSeed } from '../src/random/shuffle';
import { diffSentence } from '../src/nlp/diff';

describe('种子洗牌', () => {
  it('同种子同排列（确定性，计划验证要求）', () => {
    const words = ['stay', 'hungry', 'stay', 'foolish', 'it', 'was', 'their'];
    const a = seededShuffle(words, 'material-4-cue-0');
    const b = seededShuffle(words, 'material-4-cue-0');
    expect(a).toEqual(b);
  });

  it('不同种子大概率不同排列', () => {
    const words = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const a = seededShuffle(words, 'seed-a');
    const b = seededShuffle(words, 'seed-b');
    expect(a).not.toEqual(b);
  });

  it('不修改原数组且元素守恒', () => {
    const words = ['a', 'b', 'c', 'd', 'e'];
    const origin = [...words];
    const out = seededShuffle(words, 42);
    expect(words).toEqual(origin);
    expect([...out].sort()).toEqual([...words].sort());
  });

  it('hashSeed 稳定', () => {
    expect(hashSeed('pinglc')).toBe(hashSeed('pinglc'));
    expect(hashSeed('pinglc')).not.toBe(hashSeed('pinglx'));
  });
});

describe('听写比对', () => {
  it('完全正确（大小写与标点宽容）', () => {
    const d = diffSentence('Stay hungry, stay foolish.', 'stay hungry stay foolish');
    expect(d.exact).toBe(true);
    expect(d.score).toBe(1);
    expect(d.items.every((x) => x.status === 'correct')).toBe(true);
  });

  it('拼写小错标记 typo 且得分 0.5 权重', () => {
    const d = diffSentence('stay hungry', 'stay hungary');
    expect(d.items[1]!.status).toBe('typo');
    expect(d.score).toBe(0.75);
    expect(d.exact).toBe(false);
  });

  it('漏词标记 missing（对齐歧义下 missing 集合属于原文）', () => {
    const d = diffSentence('stay hungry stay foolish', 'stay foolish');
    const missing = d.items.filter((x) => x.status === 'missing');
    expect(missing).toHaveLength(2);
    // 'stay' 出现两次：漏的可能是第一个 stay 或 hungry，但对齐必然守恒
    const missingSet = new Set(missing.map((x) => x.target));
    expect(missingSet.has('hungry') || missingSet.has('stay')).toBe(true);
    expect(d.score).toBeGreaterThan(0);
  });

  it('多词标记 extra 且拉低得分（正确句+垃圾词 ≠ 满分）', () => {
    const d = diffSentence('stay hungry', 'stay very hungry now');
    const extra = d.items.filter((x) => x.status === 'extra');
    expect(extra).toHaveLength(2);
    // 2 correct / (2 + 2 extra) = 0.5
    expect(d.score).toBe(0.5);
    expect(d.exact).toBe(false);
  });

  it('词序颠倒：恰一对匹配 + 一漏一多（LCS 语义的正确行为）', () => {
    const d = diffSentence('stay hungry', 'hungry stay');
    const correct = d.items.filter((x) => x.status === 'correct');
    const missing = d.items.filter((x) => x.status === 'missing');
    const extra = d.items.filter((x) => x.status === 'extra');
    expect(correct).toHaveLength(1);
    expect(missing).toHaveLength(1);
    expect(extra).toHaveLength(1);
    expect(d.exact).toBe(false);
  });

  it('空输入全 missing 得 0 分', () => {
    const d = diffSentence('stay hungry', '');
    expect(d.score).toBe(0);
    expect(d.items.every((x) => x.status === 'missing')).toBe(true);
  });
});
