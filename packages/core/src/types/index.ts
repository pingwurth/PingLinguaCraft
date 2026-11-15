/**
 * @pinglc/core 领域类型定义
 *
 * 定义 web 端与移动端（Expo）共享的核心数据结构：
 * 词级时间戳、字幕句段（cue）、材料、学习进度等。
 * 这些类型与数据库 schema（apps/web/src/lib/db/schema.ts）字段一一对应，
 * 但保持纯数据形态（无 ORM 依赖），便于双端复用。
 * API 响应 DTO（双端共用的接口契约）见 ./api.ts。
 */

export * from './api';

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
 * 双语字幕句段（cue）：数据库 cues 表的纯数据形态
 * @property index        句序号（材料内唯一，从 0 开始）
 * @property startMs      起始时间（毫秒）
 * @property endMs        结束时间（毫秒）
 * @property textEn       英文原文
 * @property textZh       中文译文（可为空，翻译完成前不存在）
 * @property words        词级时间戳列表（STT 产出，可缺省）
 * @property isEdited     是否被人工编辑过
 */
export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  textEn: string;
  textZh?: string | null;
  words?: WordTiming[];
  isEdited?: boolean;
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
 * 字幕显示模式（播放器内切换）：
 * - en       仅英文
 * - zh       仅中文
 * - bilingual 双语
 * - off      关闭字幕
 */
export type SubtitleMode = 'en' | 'zh' | 'bilingual' | 'off';

/**
 * 循环播放模式：
 * - none     顺序播放
 * - sentence 单句循环
 * - ab       A-B 片段循环
 * - episode  单集循环
 */
export type LoopMode = 'none' | 'sentence' | 'ab' | 'episode';

/**
 * AI 能力类别：STT 转写 / TTS 合成 / 音素对齐 / 翻译 / 大语言模型
 */
export type AICapability = 'stt' | 'tts' | 'align' | 'translate' | 'llm';

/**
 * AI 服务配置档案（provider_profiles 表的纯数据形态）
 * @property capability  能力类别
 * @property name        档案显示名（如「本地 faster-whisper」「GLM-4.7」）
 * @property kind        local=本地引擎 / cloud=云端 OpenAI 兼容端点
 * @property endpointUrl 云端 API 地址（kind=cloud 时必填）
 * @property model       模型名（云端模型或本地模型规格）
 * @property params      附加参数（如 TTS 音色、STT VAD 开关等）
 * @property isDefault   是否为该能力当前默认档案
 */
export interface ProviderProfile {
  id: number;
  capability: AICapability;
  name: string;
  kind: 'local' | 'cloud';
  endpointUrl?: string | null;
  model?: string | null;
  params?: Record<string, unknown>;
  isDefault: boolean;
}

/**
 * 任务类型枚举（jobs 表 type 字段）
 */
export type JobType =
  | 'yt_download'
  | 'extract_audio'
  | 'stt'
  | 'translate'
  | 'tts_batch'
  | 'restt_cue'
  | 'ai_note'
  | 'ai_analysis'
  | 'ai_quiz'
  | 'level_page'
  | 'etymology'
  | 'shadow_score';

/**
 * 任务状态
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * 任务行的纯数据形态（前端轮询用）
 */
export interface JobInfo {
  id: string;
  type: JobType;
  status: JobStatus;
  materialId?: number | null;
  cueId?: number | null;
  progress: number; // 0~1
  message?: string | null;
  error?: string | null;
  createdAt: number;
  finishedAt?: number | null;
}
