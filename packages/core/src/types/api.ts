/**
 * Web API 响应 DTO（Data Transfer Object）类型
 *
 * 这些形态与 apps/web 的 API 路由响应一一对应，web 与 Expo 双端共用
 * （此前 mobile 手工缩水复制一份，字段漂移只能在运行时炸——收敛到 core
 * 单一来源后，改契约时双端编译期同时现形）。
 * 注意：仅为类型（零运行时代码），字段语义见对应 API 路由。
 */

import type { AICapability, JobStatus, MaterialSourceType, SubtitleStatus, WordTiming } from './primitives';
import type { WordDiffItem } from '../nlp/diff';

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
  /** 档案附加参数（JSON 字符串原样；如 TTS 本地档案的 {"engine":"kokoro"}） */
  paramsJson?: string | null;
}

/** 引擎能力明细（与 engine /system/capabilities 对应；web 服务端 engine.ts 亦复用此类型） */
export interface EngineCapabilities {
  stt: { faster_whisper: boolean; whisperx: boolean };
  tts: { edge_tts: boolean; kokoro: boolean; kokoro_models: boolean };
  align: { whisperx: boolean; mfa_docker: boolean };
  cuda: boolean;
  yt_dlp: boolean;
  ffmpeg: boolean;
}

/** 引擎能力（健康检查） */
export interface EngineInfo {
  healthy: boolean;
  capabilities: EngineCapabilities | null;
  /** 能力探测失败时的错误说明（此时 healthy 仍为 true、capabilities 为 null） */
  error?: string;
}

/** TTS 音色选项（引擎 /tts/voices 条目；value=引擎音色名，label=中文展示） */
export interface TtsVoiceOption {
  value: string;
  label: string;
}

/** TTS 音色清单（GET /api/engine/tts-voices；清单与默认值均只在引擎持一份，web 不硬编码） */
export interface TtsVoiceOptions {
  /** edge 联网引擎清单 */
  edge: TtsVoiceOption[];
  /** kokoro 本地离线引擎清单 */
  kokoro: TtsVoiceOption[];
  /** 云端（阿里云 WebSocket）系统音色清单 */
  cloud: TtsVoiceOption[];
  /** 三引擎默认音色（表单留空时的引擎侧兜底，展示在 placeholder） */
  defaults: { edge: string; kokoro: string; cloud: string };
}

/** 口语评测音素级评分（引擎 /soe 归一化；matchTag 语义同词级） */
export interface SpeechEvalPhone {
  /** 实际发出的音素 */
  phone: string;
  /** 参考音素（标准发音） */
  referencePhone: string;
  /** 音素准确度（0~100） */
  accuracy: number;
  matchTag: number;
  /** 标准发音是否重读 */
  stress: boolean;
  /** 实际发音是否检出重读 */
  detectedStress: boolean;
}

/**
 * 口语评测词级评分（引擎 /soe 归一化）
 * matchTag 语义（腾讯云 SOE 文档 1774/107384）：0 匹配 / 1 增读（多读）/ 2 漏读（少读）/ 3 错读 / 4 未录入
 */
export interface SpeechEvalWord {
  word: string;
  /** 该词发音准确度（0~100；漏读词为 -1） */
  accuracy: number;
  matchTag: number;
  beginMs: number;
  endMs: number;
  /** 音素级明细（引擎未返回时为空数组） */
  phones: SpeechEvalPhone[];
}

/** 口语评测三维分 + 词级明细（腾讯云 SOE 归一化；fluency 0~100，completion 0~1） */
export interface SpeechEvalDetail {
  accuracy: number;
  fluency: number;
  completion: number;
  words: SpeechEvalWord[];
}

/** 引擎 /soe 归一化返回的音素明细（snake_case 线契约，见 SoeEvalResult） */
export interface SoeEvalPhone {
  phone: string;
  reference_phone: string;
  accuracy: number;
  match_tag: number;
  stress: boolean;
  detected_stress: boolean;
}

/** 引擎 /soe 归一化返回的词级明细（snake_case 线契约，见 SoeEvalResult） */
export interface SoeEvalWord {
  word: string;
  accuracy: number;
  match_tag: number;
  begin_ms: number;
  end_ms: number;
  phones: SoeEvalPhone[];
}

/**
 * 引擎 /soe 归一化返回形态（snake_case，与 soe_tencent.normalize_result 一一对应）
 * web 路由负责将其转为 camelCase 的 SpeechEvalDetail DTO；集中在此避免各处手抄漂移
 */
export interface SoeEvalResult {
  score: number;
  accuracy: number;
  fluency: number;
  completion: number;
  status: string;
  words: SoeEvalWord[];
}

/** 跟读评分响应（POST /api/cues/:id/shadow-score） */
export interface ShadowScoreDTO {
  /** 综合分（0~100；SOE 用建议分 SuggestedScore，proxy 用词级相似度） */
  score: number;
  /** 实际读出的内容（SOE 按评测词序重建；proxy 为 STT 转写） */
  heard: string;
  /** 本地近似评分的词级比对（SOE 路径为 null） */
  diff: { items: WordDiffItem[]; exact: boolean } | null;
  note?: string | null;
  /** 评分来源：soe=云端口语评测（配置 speech_eval 档案时）；proxy=本地 STT 近似评分 */
  engine: 'soe' | 'proxy';
  /** 云端口语评测的三维分与词级明细（proxy 路径为 null） */
  detail: SpeechEvalDetail | null;
}
