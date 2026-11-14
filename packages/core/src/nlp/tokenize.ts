/**
 * 英文分词工具
 *
 * 面向「点击单词」「生词去重统计」两个场景：
 * - 保留缩写整词（don't / I'm / o'clock 不拆开）
 * - 连字符词保留整词（well-known / state-of-the-art）
 * - 归一化：统计时小写化、去掉所有标点
 */

/**
 * 英文单词匹配正则：字母序列，允许内部撇号（缩写）与连字符（复合词）
 * 例如 "don't" / "well-known" / "o'clock" 均匹配为整词
 */
const WORD_RE = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;

/**
 * 从文本中提取英文单词（保留原文大小写与撇号/连字符形态）
 * @param text 任意文本
 * @returns 单词数组（保留原始形态，含可能的重复）
 */
export function extractWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/**
 * 归一化单词：小写化、撇号统一为 ASCII、去首尾连字符
 * 用于去重统计与生词本查重（lemma 的轻量版本，不做词形还原）
 * @param word 原始单词
 * @returns 归一化后的单词
 */
export function normalizeWord(word: string): string {
  return word
    .replace(/’/g, "'")
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

/**
 * 统计文本中的不重复单词数（需求 5：单词数量需去重）
 * 直接复用 uniqueWords 的集合逻辑，保证计数与生词本查重集合口径永远一致
 * @param text 英文文本
 * @returns 去重后的单词数量（归一化后统计）
 */
export function uniqueWordCount(text: string): number {
  return uniqueWords(text).size;
}

/**
 * 统计文本中的不重复单词集合（供生词本比对等场景）
 * @param text 英文文本
 * @returns 归一化后的去重单词集合
 */
export function uniqueWords(text: string): Set<string> {
  const set = new Set<string>();
  for (const w of extractWords(text)) {
    const n = normalizeWord(w);
    if (n.length > 0) set.add(n);
  }
  return set;
}
