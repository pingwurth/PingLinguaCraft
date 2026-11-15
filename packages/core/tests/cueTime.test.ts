/**
 * 媒体时间轴测试：findCueIndex 二分查句的边界行为（web rAF 时钟与
 * mobile 音频事件回调共用，前提：startMs 升序且区间互不重叠）
 */

import { describe, expect, it } from 'vitest';
import { findCueIndex } from '../src/media/cueTime';

/** 有序不重叠的样例句段（含句间空隙） */
const cues = [
  { startMs: 0, endMs: 1000 },
  { startMs: 1500, endMs: 3000 },
  { startMs: 3200, endMs: 5000 },
];

describe('findCueIndex（二分查当前句）', () => {
  it('命中各句（首/中/尾）', () => {
    expect(findCueIndex(cues, 500)).toBe(0);
    expect(findCueIndex(cues, 2000)).toBe(1);
    expect(findCueIndex(cues, 4999)).toBe(2);
  });

  it('t 恰等于句首/句尾边界：含首不含尾', () => {
    expect(findCueIndex(cues, 1500)).toBe(1);
    expect(findCueIndex(cues, 3000)).toBe(-1); // endMs 不属于本句
  });

  it('句间空隙与范围外：返回 -1', () => {
    expect(findCueIndex(cues, 1200)).toBe(-1); // 句 0 与句 1 之间
    expect(findCueIndex(cues, -100)).toBe(-1); // 首句之前
    expect(findCueIndex(cues, 9999)).toBe(-1); // 末句之后
  });

  it('空数组：返回 -1', () => {
    expect(findCueIndex([], 0)).toBe(-1);
  });

  it('单句数组', () => {
    expect(findCueIndex([{ startMs: 100, endMs: 200 }], 150)).toBe(0);
    expect(findCueIndex([{ startMs: 100, endMs: 200 }], 300)).toBe(-1);
  });
});
