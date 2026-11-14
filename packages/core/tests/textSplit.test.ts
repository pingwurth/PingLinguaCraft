/**
 * 纯文本分句测试（文本导入路径）
 *
 * 覆盖：段落边界、缩写守卫、小数守卫、段尾碎片合并、超长句逗号兜底切分。
 */
import { describe, expect, it } from 'vitest';
import { splitSentences } from '../src/nlp/textSplit';

describe('纯文本分句', () => {
  it('句末标点 + 大写开头断句，段落边界必断', () => {
    const text = `Stay hungry, stay foolish. It was their farewell message.
Second paragraph here.`;
    expect(splitSentences(text)).toEqual([
      'Stay hungry, stay foolish.',
      'It was their farewell message.',
      'Second paragraph here.',
    ]);
  });

  it('缩写词不触发断句', () => {
    const out = splitSentences('Mr. Smith said e.g. a cat. Then he left.');
    expect(out).toEqual(['Mr. Smith said e.g. a cat.', 'Then he left.']);
  });

  it('小数不断句', () => {
    const out = splitSentences('It cost 3.14 dollars. Yes.');
    expect(out).toEqual(['It cost 3.14 dollars.', 'Yes.']);
  });

  it('句点后小写开头视为误判标点', () => {
    const out = splitSentences('visit example.com for more. Next one.');
    // ".com for more." 的句点后是小写 for，直到 "more." 后的大写 Next 才断
    expect(out).toEqual(['visit example.com for more.', 'Next one.']);
  });

  it('无标点段尾碎片并入上一句', () => {
    const out = splitSentences('A full sentence here. ok');
    expect(out).toEqual(['A full sentence here. ok']);
  });

  it('超长句在逗号处兜底切分', () => {
    const long = Array.from({ length: 40 }, (_, i) => `part${i},`).join(' ') + ' end.';
    const out = splitSentences(long, { maxChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(130);
    // 切分不丢内容
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });

  it('空文本返回空数组', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});
