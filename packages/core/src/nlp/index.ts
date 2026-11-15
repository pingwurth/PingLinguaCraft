/**
 * NLP 模块出口：分词、去重统计、词流分句、纯文本分句、听写比对
 */
export { extractWords, normalizeWord, uniqueWordCount, uniqueWords } from './tokenize';
export { segmentWords } from './sentences';
export type { SegmentOptions, SegmentedCue } from './sentences';
export { splitSentences } from './textSplit';
export type { TextSplitOptions } from './textSplit';
export { ABBREVIATIONS } from './abbreviations';
export { diffSentence } from './diff';
export type { WordDiffItem, WordDiffStatus, SentenceDiff } from './diff';
