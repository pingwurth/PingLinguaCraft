/**
 * 领域原子类型（叶子模块）
 *
 * 被 index.ts 与 api.ts 共同依赖的基础枚举/原子结构单独成叶，保持类型
 * 依赖图无环（api.ts 若从 './index' 引用会与其 `export * from './api'`
 * 构成环——type-only 时无害，但一旦引入运行时值就会踩模块求值顺序）。
 */

/**
 * 词级时间戳：STT/对齐产出的单个单词信息
 * @property w  单词文本
 * @property s  起始时间（秒，浮点）
 * @property e  结束时间（秒，浮点）
 * @property p  识别置信度概率（0~1，可选，来自 faster-whisper）
 */
export interface WordTiming {
  w: string;
  s: number;
  e: number;
  p?: number;
}

/**
 * 材料来源类型：
 * - audio  本地音频文件
 * - video  本地视频文件
 * - text   纯文本导入（TTS 生成音频）
 * - link   链接导入（yt-dlp 下载，YouTube/Bilibili/TED 等）
 */
export type MaterialSourceType = 'audio' | 'video' | 'text' | 'link';

/**
 * 字幕就绪状态：
 * - none       无字幕（刚导入）
 * - processing 字幕生成中（STT/翻译进行中）
 * - ready      字幕就绪可学习
 * - failed     生成失败（可重试）
 */
export type SubtitleStatus = 'none' | 'processing' | 'ready' | 'failed';

/**
 * AI 能力类别：STT 转写 / TTS 合成 / 音素对齐 / 翻译 / 大语言模型 / 口语评测
 */
export type AICapability = 'stt' | 'tts' | 'align' | 'translate' | 'llm' | 'speech_eval';

/**
 * 任务状态
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
