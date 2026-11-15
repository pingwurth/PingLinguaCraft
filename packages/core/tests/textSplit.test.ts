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

  it('硬切前先落盘已聚合词：输出顺序与原文一致（不把前词排到切块之后）', () => {
    // 旧实现：'aaa' 聚在 current 里未 flush，x*700 的硬切块直接入 out，
    // 结果 [x*100 ×7, 'aaa bbb']——前词静默跳到末尾
    const text = 'aaa ' + 'x'.repeat(700) + ' bbb';
    const out = splitSentences(text, { maxChars: 100 });
    expect(out[0]).toBe('aaa');
    expect(out[out.length - 1]).toBe('bbb');
    expect(out.slice(1, -1).every((s) => /^x+$/.test(s) && s.length === 100)).toBe(true);
    // 内容无损（切块间由 join 注入空格，只校验切块串接后 x 连续段完整）
    expect(out.slice(1, -1).join('')).toBe('x'.repeat(700));
  });

  it('硬切切点避开代理对：emoji 不被切成孤代理', () => {
    const emoji = '😀'.repeat(250); // 每个Emoji是 1 个代理对（2 个 UTF-16 码元）
    const out = splitSentences(emoji, { maxChars: 101 }); // 奇数上限会落在代理对中间
    expect(out.length).toBeGreaterThan(1);
    // 切点回退后每块码元数为偶数（无孤代理），内容无损
    for (const s of out) expect(s.length % 2).toBe(0);
    expect(out.join('')).toBe(emoji);
  });

  it('非法 maxChars 防御：0/负数/NaN 回退默认 600，不死循环不静默禁用', () => {
    // 0/负数旧实现会让 st += maxChars 永不推进（死循环），NaN 会禁用全部兜底切分
    const long = 'y'.repeat(1300);
    expect(splitSentences(long, { maxChars: 0 })[0]!.length).toBe(600);
    expect(splitSentences(long, { maxChars: -5 })[0]!.length).toBe(600);
    expect(splitSentences(long, { maxChars: Number.NaN })[0]!.length).toBe(600);
    // 小数向下取整（切长为正整数）
    expect(splitSentences(long, { maxChars: 100.9 })[0]!.length).toBe(100);
  });

  it('缩写前瞻守卫仅对句点生效：?/! 后是真句界不被吞', () => {
    // 旧实现：? 后跟 "A." 会命中前瞻守卫，两句被并成一句
    const out = splitSentences('Do you agree? A. Smith did.');
    expect(out[0]).toBe('Do you agree?');
    expect(out.length).toBeGreaterThan(1);
    // 真句点后的列表字母情形：前一词为 3 字母（>2），不触发守卫
    const out2 = splitSentences('Choose one. A. red');
    expect(out2[0]).toBe('Choose one.');
  });

  it('多字母缩写链首段同样放行：Ph.D. 不被拆成 "Ph." + "D. …"', () => {
    // bare 为 2 字母的缩写链首（Ph.）+ 下一词为 D. → 守卫放行；末段句点处
    // （D. 后无「字母+句点」）正常断句
    const out = splitSentences('He has a Ph.D. in physics.');
    expect(out[0]).toBe('He has a Ph.D. in physics.');
  });

  it('尾碎片合并的边界：数字小数点并入、字母句点独立', () => {
    // "3.5" 的点不是句界，作为尾碎片并入上一句
    expect(splitSentences('It costs. 3.5')).toEqual(['It costs. 3.5']);
    // "A. red" 含字母+句点，像独立列表项，不回并
    const out = splitSentences('Choose one. A. red');
    expect(out[out.length - 1]).toBe('A. red');
  });

  it('maxChars 下限钳到 2：切长 1 无法回退代理对切点', () => {
    const emoji = '😀'.repeat(5); // 5 个代理对
    const out = splitSentences(emoji, { maxChars: 1 });
    for (const s of out) expect(s.length % 2).toBe(0); // 无孤代理
    expect(out.join('')).toBe(emoji);
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
