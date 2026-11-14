/**
 * 英文缩写词典（分句共用的语言数据）
 *
 * 这些词以句点结尾但不是句末（Mr. Smith / e.g. a cat / U.S. government）。
 * 从 sentences.ts 抽出共享：词流分句与文本分句使用同一份词典，行为一致。
 */

/**
 * 缩写词集合（小写、不含结尾句点）
 * 注意：'no'（No. = numero 缩写）刻意不收录——普通单词 no. 的使用频率远高于缩写，
 * 收录会导致 "I said no. Then we left." 永不断句。
 */
export const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'e.g', 'i.e', 'u.s', 'u.k', 'fig', 'approx', 'dept', 'inc', 'ltd',
  'co', 'al', 'cf', 'ca', 'vol', 'ed', 'pp',
]);
