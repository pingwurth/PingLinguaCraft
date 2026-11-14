/**
 * 分词与分句金样本测试
 *
 * 分词：缩写整词（don't）、连字符词（well-known）、去重统计小写化。
 * 分句：句末标点启发、缩写词典、小数/编号守卫、词数/时长上限、padding 与相邻钳制。
 */
import { describe, expect, it } from 'vitest';
import { extractWords, normalizeWord, uniqueWordCount } from '../src/nlp/tokenize';
import { segmentWords } from '../src/nlp/sentences';
import type { WordTiming } from '../src/types';

/** 便捷构造词时间戳 */
const w = (word: string, s: number, e = s + 0.4, p = 0.9): WordTiming => ({ w: word, s, e, p });

describe('分词', () => {
  it('保留缩写整词', () => {
    expect(extractWords("Don't stop, I'm here.")).toEqual(["Don't", 'stop', "I'm", 'here']);
  });
  it('保留连字符复合词', () => {
    expect(extractWords('a well-known result')).toEqual(['a', 'well-known', 'result']);
  });
  it('归一化：小写 + 弯撇号转直撇号', () => {
    expect(normalizeWord('Don’t')).toBe("don't");
    expect(normalizeWord('Well-Known')).toBe('well-known');
  });
  it('去重统计（大小写/撇号形态归一）', () => {
    expect(uniqueWordCount("The the THE don't don’t")).toBe(2);
  });
  it('空文本与纯标点', () => {
    expect(uniqueWordCount('')).toBe(0);
    expect(uniqueWordCount('... !? —')).toBe(0);
  });
});

describe('词流分句', () => {
  it('句号 + 下词大写 → 断句', () => {
    const cues = segmentWords([
      w('Hello', 0.0), w('world.', 0.5), w('Next', 1.2), w('sentence.', 1.8),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('Hello world.');
    expect(cues[1]!.text).toBe('Next sentence.');
  });

  it('缩写词不触发断句（Mr. Smith / e.g.）', () => {
    const cues = segmentWords([
      w('Mr.', 0.0), w('Smith', 0.3), w('said', 0.8), w('e.g.', 1.2), w('a', 1.5), w('cat.', 1.8),
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('Mr. Smith said e.g. a cat.');
  });

  it('句点后跟小写 → 视为误判标点不断句', () => {
    const cues = segmentWords([
      w('the', 0.0), w('u.s.', 0.3), w('is', 0.6), w('big.', 0.9), w('yes', 1.3), w('?', 1.6),
    ]);
    // "big." 后为小写 yes → 不断；"? " 为句末
    expect(cues).toHaveLength(1);
  });

  it('小数守卫：句点后跟数字不断句', () => {
    const cues = segmentWords([
      w('It', 0.0), w('cost', 0.2), w('3.', 0.5), w('5', 0.7), w('dollars.', 1.0),
    ]);
    expect(cues).toHaveLength(1);
  });

  it('词数上限强制断句（无标点长流）', () => {
    const words = Array.from({ length: 65 }, (_, i) => w(`word${i}`, i * 0.3));
    const cues = segmentWords(words, { maxWords: 30 });
    // 65 词 / 30 上限 → 至少 3 段
    expect(cues.length).toBeGreaterThanOrEqual(3);
    for (const c of cues) expect(c.words.length).toBeLessThanOrEqual(30);
  });

  it('时长上限强制断句', () => {
    // 词距 0.6s：30 词（默认词数上限）需 18s > 15s，确保时长分支先于词数分支触发
    const words = Array.from({ length: 100 }, (_, i) => w(`w${i}`, i * 0.6));
    const cues = segmentWords(words, { maxDurationMs: 15_000 });
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.words.length).toBeLessThan(30); // 证明不是词数上限在断句
    for (const c of cues) expect(c.endMs - c.startMs).toBeLessThanOrEqual(15_000 + 600);
  });

  it('padding 应用：句首 -80ms 句尾 +150ms，且不越界到 0 以下', () => {
    const cues = segmentWords([w('Hi.', 1.0, 1.5), w('There.', 2.0, 2.5)]);
    expect(cues[0]!.startMs).toBe(920); // 1000 - 80
    expect(cues[0]!.endMs).toBe(1650); // 1500 + 150
    // 首句 padding 后与第二句 start（2000-80=1920）无重叠
    expect(cues[0]!.endMs).toBeLessThanOrEqual(cues[1]!.startMs);
  });

  it('相邻钳制：padding 导致重叠时收敛到前句 endMs', () => {
    // 第一句结束 1.9s + 150ms = 2050ms，第二句 start 2.0s - 80ms = 1920ms → 重叠
    const cues = segmentWords([w('One.', 0.5, 1.9), w('Two.', 2.0, 2.5)]);
    expect(cues[1]!.startMs).toBe(cues[0]!.endMs);
  });

  it('"no." 是普通单词而非缩写：下词大写即断句', () => {
    // 'no' 不再收录进缩写词典（No.=numero 用法罕见，普通 no. 更高频）
    const cues = segmentWords([
      w('I', 0.0), w('said', 0.2), w('no.', 0.5), w('Then', 0.9), w('we', 1.2), w('left.', 1.5),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('I said no.');
    expect(cues[1]!.text).toBe('Then we left.');
  });

  it('钳制后词不早于所属句 startMs（回缩前句 padding 而非推挤本句词）', () => {
    // 前句尾 padding 与本句首词重叠：优先回缩前句 endMs 到 2000ms（Two 的起点），
    // 本句 start 随之为 2000ms，词原始时间戳不动
    const cues = segmentWords([w('One.', 0.5, 1.9), w('Two.', 2.0, 2.5)]);
    expect(cues[1]!.startMs).toBe(cues[0]!.endMs);
    expect(cues[0]!.endMs).toBe(2000);
    expect(cues[1]!.words[0]!.s).toBe(2.0); // 词起点不被篡改
    for (const c of cues) {
      for (const word of c.words) {
        expect(word.s).toBeGreaterThanOrEqual(c.startMs / 1000 - 1e-9);
      }
    }
  });

  it('前句尾 padding 吞没后句全部词：不丢词不崩溃，回缩前句 padding', () => {
    // 前句末词 1.000s 结束（padding 后 endMs=1150ms）；后句唯一词 1.040→1.140s，
    // 完整落在前句 padding 区间——旧实现会把它 filter 掉：words 清空后 words[last] 越界崩溃
    const cues = segmentWords([w('Bye.', 0.5, 1.0), w('Hi.', 1.04, 1.14)]);
    expect(cues).toHaveLength(2);
    expect(cues[1]!.words).toHaveLength(1);   // 词保留，不被丢弃
    expect(cues[1]!.text).toBe('Hi.');        // 文本与词表保持一致
    expect(cues[1]!.words[0]!.s).toBe(1.04);  // 原始时间戳不被篡改
    expect(cues[0]!.endMs).toBe(1040);        // 前句尾 padding 回缩到后句首词起点
    expect(cues[1]!.startMs).toBe(1040);      // 无重叠且不吞词
  });

  it('快语速场景：前句 padding 区间内的短词不静默丢失', () => {
    // "…left." 后仅 40ms 就开始 "Then"（整词落在前句 150ms 尾 padding 内），旧实现会丢词
    const cues = segmentWords([
      w('we', 0.2, 0.6), w('left.', 0.6, 1.0),
      w('Then', 1.04, 1.14), w('we', 1.2, 1.6), w('ran.', 1.6, 2.0),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[1]!.text).toBe('Then we ran.'); // "Then" 不再被丢弃
    expect(cues[1]!.words.map((wd) => wd.w)).toEqual(['Then', 'we', 'ran.']);
    expect(cues[0]!.endMs).toBe(cues[1]!.startMs); // 句段无重叠
  });

  it('词流自身重叠（STT 常见）：回缩不把前句末词挤出区间，越界词只钳起点', () => {
    // 前句末词 1.5→1.9s，后句首词 1.85→2.2s——两词时间戳重叠（STT 对齐误差）。
    // 回缩地板含前句末词终点：endMs 回缩到 1900 而非 1850，前句词仍在区间内；
    // 后句首词起点 1.85 < 1.9 被钳进区间，词保留、文本不变
    const cues = segmentWords([w('One.', 0.5, 1.9), w('Bee.', 1.85, 2.2)]);
    expect(cues[0]!.endMs).toBe(1900);                 // 不低于前句末词终点
    expect(cues[1]!.startMs).toBe(1900);
    expect(cues[1]!.words).toHaveLength(1);            // 词保留
    expect(cues[1]!.text).toBe('Bee.');
    expect(cues[1]!.words[0]!.s).toBe(1.9);            // 越界起点被钳入，保持 s ≤ e
    expect(cues[1]!.words[0]!.e).toBe(2.2);
  });

  it('空词流返回空数组', () => {
    expect(segmentWords([])).toHaveLength(0);
  });
});
