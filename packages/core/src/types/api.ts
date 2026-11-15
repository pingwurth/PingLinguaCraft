/**
 * Web API 响应 DTO（Data Transfer Object）类型
 *
 * 这些形态与 apps/web 的 API 路由响应一一对应，web 与 Expo 双端共用
 * （此前 mobile 手工缩水复制一份，字段漂移只能在运行时炸——收敛到 core
 * 单一来源后，改契约时双端编译期同时现形）。
 * 注意：仅为类型（零运行时代码），字段语义见对应 API 路由。
 */

import type { AICapability, JobStatus, MaterialSourceType, SubtitleStatus, WordTiming } from './index';

/** 材料集（列表形态） */
export interface Collection {
  id: number;
  name: string;
  description: string | null;
  cover: string | null;
  cefrLevel: string | null;
  materialCount: number;
  totalDurationMs: number;
}

/** 材料（列表形态） */
export interface MaterialListItem {
  id: number;
  title: string;
  sourceType: MaterialSourceType;
  mediaMime: string | null;
  mediaDurationMs: number | null;
  subtitleStatus: SubtitleStatus;
  sentenceCount: number | null;
  uniqueWordCount: number | null;
  createdAt: string;
}

/** 材料（详情形态） */
export interface MaterialDetail {
  id: number;
  collectionId: number;
  title: string;
  sourceType: MaterialSourceType;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaDurationMs: number | null;
  subtitleStatus: SubtitleStatus;
  sentenceCount: number | null;
  uniqueWordCount: number | null;
  peaksPath: string | null;
}

/** 句段（前端形态，words 已解析） */
export interface CueDTO {
  id: number;
  materialId: number;
  index: number;
  startMs: number;
  endMs: number;
  textEn: string;
  textZh: string | null;
  translationProvider: string | null;
  sttConfidence: number | null;
  words: Array<WordTiming> | null;
  isEdited: boolean;
  noteMd: string | null;
}

/** 学习进度 */
export interface ProgressDTO {
  lastPositionMs: number;
  maxCueIndex: number;
  listenedThrough: boolean;
}

/** 任务（轮询形态；type 保持宽松 string——管线任务类型在演进） */
export interface JobDTO {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  materialId: number | null;
  cueId: number | null;
}

/** AI 档案（掩码形态：api_key 永不回传，只回传是否已配置） */
export interface ProviderDTO {
  id: number;
  capability: AICapability;
  name: string;
  kind: 'local' | 'cloud';
  endpointUrl: string | null;
  model: string | null;
  isDefault: boolean;
  hasKey: boolean;
}

/** 引擎能力（健康检查） */
export interface EngineInfo {
  healthy: boolean;
  capabilities: {
    stt: { faster_whisper: boolean; whisperx: boolean };
    tts: { edge_tts: boolean; kokoro: boolean };
    align: { whisperx: boolean; mfa_docker: boolean };
    cuda: boolean;
    yt_dlp: boolean;
    ffmpeg: boolean;
  } | null;
}
