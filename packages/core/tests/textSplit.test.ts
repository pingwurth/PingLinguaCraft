/**
 * 纯文本分句测试（文本导入路径）
 *
 * 覆盖：段落边界、缩写守卫（词典/多段前瞻/小数）、段尾碎片合并、超长句兜底切分
 * （半角/全角标点、无标点词边界、病态超长单词硬切）。
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

  it('大写多段缩写不在首段误切（词典要到末段才命中，首段靠前瞻守卫）', () => {
    // U.S. 后接大写 Government：isBoundary 认大写后继为真句界，无前瞻会在 "U." 误切
    const out = splitSentences('The U.S. Government responded quickly. Then it ended.');
    expect(out).toEqual(['The U.S. Government responded quickly.', 'Then it ended.']);
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

  it('兜底切分严格不超过 maxChars 上界', () => {
    // 单个逗号段本身就超长（旧实现会整段穿透）
    const long = 'short, ' + 'x'.repeat(300) + ', tail';
    const out = splitSentences(long, { maxChars: 100 });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(100);
  });

  it('全角逗号/分号参与兜底切分，中文长文本不整段穿透', () => {
    const long =
      '这是一段故意写得非常长的中文句子用来验证超长兜底切分，第一分句讲规则背景，' +
      '第二分句说明全角逗号应当构成切点，第三分句确保每个输出都不超过上界，收尾。';
    const out = splitSentences(long, { maxChars: 40 });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(40);
    // 全角切点后无空白被消耗，内容原样保留
    expect(out.join('')).toBe(long);
  });

  it('无标点超长句按词边界贪心切', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const out = splitSentences(words.join(' '), { maxChars: 60 });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(60);
    expect(out.join(' ')).toBe(words.join(' '));
  });

  it('病态超长单词（无空白可分）硬切保上界', () => {
    const out = splitSentences('a'.repeat(250), { maxChars: 100 });
    expect(out).toEqual(['a'.repeat(100), 'a'.repeat(100), 'a'.repeat(50)]);
  });

  it('半角冒号无空白跟随不构成切点（12:30 不被切开）', () => {
    // 触发兜底切分（>maxChars）但时间里的冒号后无空白，不应在 12: 30 处断开注入空格
    const long = Array.from({ length: 40 }, (_, i) => `item${i}`).join(' ') + ' at 12:30 end.';
    const out = splitSentences(long, { maxChars: 80 });
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
    expect(out.some((s) => s.includes('12:') && s.includes('30'))).toBe(true);
  });

  it('空文本返回空数组', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});
