/**
 * 字幕模块出口：时间码工具 + 共享块解析基础 + SRT/VTT 解析与序列化
 */
export { parseTimestamp, formatTimestamp } from './time';
export { parseGeneric, pickCueLines } from './block';
export type { ParseResult } from './block';
export { parseSrt, serializeSrt } from './srt';
export { parseVtt, serializeVtt } from './vtt';
