/**
 * @pinglc/core 出口汇总
 *
 * 该包是 web 与 Expo 双端共享的纯逻辑层（零运行时依赖）：
 * - subtitles：SRT/VTT 解析与序列化、时间码工具
 * - nlp：英文分词、去重统计、STT 词流分句、纯文本分句、听写比对
 * - random：种子洗牌（可复现乱序）
 * - srs：间隔重复调度（FSRS，M4 完整实现）
 * - types：领域类型（与 DB schema 对应的纯数据形态）
 */
export * from './types';
export * from './subtitles';
export * from './nlp';
export * from './random';
export * from './srs';
