/**
 * 听过位图统计测试：popcount 正确性、total 截断、回归案例（旧公式曾把
 * 听 5 句算成 26，闯关解锁复核形同虚设）
 */
import { describe, expect, it } from 'vitest';
import { countListenedBits } from '../src/media/listenedMask';

describe('听过位图统计', () => {
  it('全置位 → 等于句段总数', () => {
    const mask = new Uint8Array([0xff, 0xff, 0x03]); // 18 位全置 1
    expect(countListenedBits(mask, 18)).toBe(18);
  });

  it('前半置位 → 恰为一半', () => {
    const mask = new Uint8Array([0xff, 0x03]); // 前 10 位置 1
    expect(countListenedBits(mask, 20)).toBe(10);
  });

  it('回归：0x1F（5 句）在 total=10 时计 5 而非 26', () => {
    // 旧公式 (b&0x55)+((b>>1)&0x55) 只完成 popcount 第一步（按 2bit 分组计数），
    // 高位按位权放大——0x1F 得 26 ≥ 10，听 5 句即误判「听过一遍」解锁闯关
    expect(countListenedBits(new Uint8Array([0x1f]), 10)).toBe(5);
  });

  it('只统计前 total 位：超出句段数的高位脏数据被忽略', () => {
    expect(countListenedBits(new Uint8Array([0xff]), 3)).toBe(3);
    expect(countListenedBits(new Uint8Array([0x80]), 3)).toBe(0);
  });

  it('空位图 → 0', () => {
    expect(countListenedBits(new Uint8Array(0), 10)).toBe(0);
  });
});
