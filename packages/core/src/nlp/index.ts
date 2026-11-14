/**
 * NLP 模块出口：分词、去重统计、词流分句
 */
export { extractWords, normalizeWord, uniqueWordCount, uniqueWords } from './tokenize';
export { segmentWords } from './sentences';
export type { SegmentOptions, SegmentedCue } from './sentences';
