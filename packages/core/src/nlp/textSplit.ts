/**
 * 纯文本分句器（文本导入路径：文本 → TTS 音频需要先切成句子）
 *
 * 与 sentences.ts（STT 词流分句）同源的启发式，但作用于原始文本：
 * 1. 句末标点（.!?…）+ 空白 + 大写/引号/数字开头 → 断句
 * 2. 缩写词典守卫（Mr. / e.g. / U.S. …）
 * 3. 小数与编号守卫（3.14、列表 "1. "）
 * 4. 超长句（>600 字符）在逗号/分号处兜底切分
 */

import { ABBREVIATIONS } from './abbreviations';

/** 分句可配置参数 */
export interface TextSplitOptions {
  /** 单句最大字符数，超过在逗号/分号兜底切分（默认 600，TTS 单次合成友好） */
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
  const maxChars = opts.maxChars ?? 600;
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
        // 小数/编号守卫：标点两侧都是数字
        const prevChar = p[i - 1] ?? '';
        const nextNonSpace = p.slice(i + 1).match(/\S/)?.[0] ?? '';
        const decimalGuard = /\d/.test(prevChar) && /\d/.test(nextNonSpace);

        if (!isAbbrev && !decimalGuard && isBoundary(p, i)) {
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
      if (sentences.length > 0 && rest.length < 12 && !/[.!?…]$/.test(rest)) {
        // 段尾太短的碎片并入上一句（避免孤词成句）
        sentences[sentences.length - 1] += ' ' + rest;
      } else {
        sentences.push(rest);
      }
    }
  }

  // 第三步：超长句在逗号/分号处兜底切分
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      out.push(s);
      continue;
    }
    let current = '';
    // 按逗号/分号/冒号切子串，贪心聚合到 maxChars 以内
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      if ((current + ' ' + part).trim().length > maxChars && current) {
        out.push(current.trim());
        current = part;
      } else {
        current = current ? current + ' ' + part : part;
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}
