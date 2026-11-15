/**
 * 纯文本分句器（文本导入路径：文本 → TTS 音频需要先切成句子）
 *
 * 与 sentences.ts（STT 词流分句）同源的启发式，但作用于原始文本：
 * 1. 句末标点（.!?…）+ 空白 + 大写/引号/数字开头 → 断句
 * 2. 缩写词典守卫（Mr. / e.g. / U.S. …）；多段缩写（如 U.S.）另有
 *    「前一词为单字母且下一词为单字母+句点」前瞻守卫——词典要到末段句点才命中，
 *    首段须前瞻放行；仅对句点生效（? ! … 后恒为真句界）
 * 3. 小数与编号守卫（3.14、列表 "1. "）
 * 4. 超长句兜底切分：优先逗号/分号/冒号（半角+全角），无标点段按词边界贪心切，
 *    病态超长单词硬切——保证输出不超过 maxChars，且切点不落在代理对中间
 *
 * Hermes 兼容：全程不用正则后行断言 lookbehind（Hermes/旧 Safari 上加载即 SyntaxError）
 */

import { ABBREVIATIONS } from './abbreviations';

/** 分句可配置参数 */
export interface TextSplitOptions {
  /** 单句最大字符数；超长时兜底切分：逗号/分号/冒号（半角+全角）→ 词边界 → 硬切（默认 600，TTS 单次合成友好） */
  maxChars?: number;
}

/**
 * 判断文本中某个句末标点位置是否为真句界
 * @param text   全文
 * @param punctIdx 标点字符下标
 * @returns 是否应在标点后断句
 */
function isBoundary(text: string, punctIdx: number): boolean {
  // 找标点后的第一个非空白字符
  let j = punctIdx + 1;
  while (j < text.length && /\s/.test(text[j]!)) j++;
  if (j >= text.length) return true; // 文尾
  const next = text[j]!;
  // 下一词以小写字母开头 → 视为误判标点（如网址 3.14 后接单位）
  if (/[a-z]/.test(next)) return false;
  // 大写/引号/括号/数字 开头 → 真句界
  return true;
}

/**
 * 将纯文本切分为句子数组（保留原文内容，仅去除首尾空白）
 * @param text 原始文本
 * @param opts 配置（可选）
 * @returns 句子数组（顺序与原文一致）
 */
export function splitSentences(text: string, opts: TextSplitOptions = {}): string[] {
  // 数值参数显式校验（core 纪律）：0/负数会让硬切循环 st += maxChars 永不推进
  // （死循环推爆内存），NaN 会让一切长度比较恒 false 静默禁用全部兜底切分；
  // 非法值统一回退默认 600，小数向下取整（切长必须为正整数）；下限钳到 2——
  // 切长 1 时硬切无法回退代理对切点，会破坏「不产出孤代理」的保证（且 1 字符
  // 的句子对 TTS 无意义）
  const rawMax = opts.maxChars;
  const maxChars =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.max(2, Math.floor(rawMax))
      : 600;
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return [];

  // 第一步：按换行段粗分（文本导入常带段落结构，段落边界必然断句）
  const paragraphs = trimmed.split(/\n{1,}/);

  const sentences: string[] = [];
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    // 第二步：扫描段内句末标点
    let buf = '';
    let i = 0;
    while (i < p.length) {
      const ch = p[i]!;
      buf += ch;
      if (/[.!?…]/.test(ch)) {
        // 吸收连续标点（!!、?!、…）
        while (i + 1 < p.length && /[.!?…"'”’)]/.test(p[i + 1]!)) {
          i++;
          buf += p[i]!;
        }
        // 检查标点前的词是否缩写（往前取最近的一个词；触发句点本身已被切片排除，
        // 因此「词以句点结尾」恒真，只需查词典）
        const before = buf.slice(0, -1);
        const lastWord = before.match(/[A-Za-z.]+$/)?.[0] ?? '';
        const bare = lastWord.replace(/\.$/, '').toLowerCase();
        const isAbbrev = ABBREVIATIONS.has(bare);
        // 多段缩写前瞻守卫：词典条目要到末段句点才命中，首段（如 "U." "Ph."）查不到。
        // 仅句点、前一词为 1-2 个字母（缩写链首段：U/e/a/ph…）且下一词为「字母+句点」
        // 时才可能是缩写内部——? ! … 后恒为真句界（"Do you agree? A. Smith" 的 ?
        // 不能被吞成一句）；前词长度 ≤2 排除 "Choose one. A. red" 这类真句界后跟
        // 列表字母的情形（one 为 3 字母）
        let j = i + 1;
        while (j < p.length && /\s/.test(p[j]!)) j++;
        const abbrevInner =
          ch === '.' && /^[A-Za-z]{1,2}$/.test(bare) && /^[A-Za-z]\./.test(p.slice(j));
        // 小数/编号守卫：标点两侧都是数字
        const prevChar = p[i - 1] ?? '';
        const nextNonSpace = p.slice(i + 1).match(/\S/)?.[0] ?? '';
        const decimalGuard = /\d/.test(prevChar) && /\d/.test(nextNonSpace);

        if (!isAbbrev && !abbrevInner && !decimalGuard && isBoundary(p, i)) {
          const s = buf.trim();
          if (s) sentences.push(s);
          buf = '';
        }
      }
      i++;
    }
    // 段落剩余内容（无句末标点的段）
    const rest = buf.trim();
    if (rest) {
      // 仅「真正的孤词碎片」并入上一句：含「字母+句界标点」（如 "A. red"、
      // "U.S."）的碎片像独立成句的单位，回并会把已切开的句界吞回去；数字后
      // 的小数点（"3.5"、"1.2.3"）不是句界，照常并入
      if (sentences.length > 0 && rest.length < 12 && !/[A-Za-z][.!?…]/.test(rest)) {
        // 段尾太短的碎片并入上一句（避免孤词成句）
        sentences[sentences.length - 1] += ' ' + rest;
      } else {
        sentences.push(rest);
      }
    }
  }

  // 第三步：超长句兜底切分——优先在逗号/分号/冒号（半角+全角）处切；无标点段按
  // 词边界贪心切；病态超长单词最后硬切。保证任何输出不超过 maxChars。
  // 切点匹配用前瞻 (?=\s) 而非后行断言 lookbehind——后者在 Hermes（Expo）与旧 Safari
  // 上加载即 SyntaxError（tests/hermesCompat.test.ts 有全目录机器守卫）
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      out.push(s);
      continue;
    }
    // 半角标点须后随空白才构成切点（12:30 这类时间/比例不切）；全角标点后随空白可省
    const parts: string[] = [];
    const punctRe = /[,;:](?=\s)|[，；：]/g;
    let last = 0;
    for (let m = punctRe.exec(s); m !== null; m = punctRe.exec(s)) {
      let k = m.index + m[0].length; // 标点后的空白归前段（切点空白原样保留，重组不变形）
      while (k < s.length && /\s/.test(s[k]!)) k++;
      parts.push(s.slice(last, k));
      last = k;
    }
    if (last < s.length) parts.push(s.slice(last));
    // 贪心聚合到 maxChars 以内
    let current = '';
    const flush = () => {
      const t = current.trim();
      if (t) out.push(t);
      current = '';
    };
    for (const piece of parts) {
      if (piece.trim().length > maxChars) {
        // 该段无可用标点且整段超长：按词边界贪心切
        flush();
        for (const w of piece.trim().split(/\s+/)) {
          if (w.length > maxChars) {
            // 病态超长单词（无空白可分）：硬切保上界。硬切块直接入 out，必须先把
            // current 中已聚合的词落盘——否则先来的词被排到切块之后，静默打乱
            // 与原文一致的输出顺序（本函数的契约）
            flush();
            for (let st = 0; st < w.length; ) {
              let en = Math.min(st + maxChars, w.length);
              // 切点落在代理对中间（emoji/扩展 CJK）会产出孤代理进入 TTS/字幕：
              // 高代理恰在切点前一位时回退一位错开；maxChars=1 的极端无法回退只能拆对
              if (en < w.length && en - 1 > st) {
                const prev = w[en - 1]!;
                if (prev >= '\uD800' && prev <= '\uDBFF') en--;
              }
              out.push(w.slice(st, en));
              st = en;
            }
          } else if ((current + ' ' + w).length > maxChars && current) {
            flush();
            current = w;
          } else {
            current = current ? current + ' ' + w : w;
          }
        }
        flush();
      } else if ((current + piece).trim().length > maxChars && current) {
        flush();
        current = piece;
      } else {
        current += piece;
      }
    }
    flush();
  }
  return out;
}
