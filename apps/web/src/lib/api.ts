/**
 * 前端 API 客户端：类型化 fetch 封装（页面与 react-query 共用）
 *
 * 约定：错误响应 { error } → 抛 ApiError（消息可直接展示）。
 */

/** API 错误（服务端 error 字段或网络异常文本） */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

/**
 * 通用请求封装
 * @param path 路径（/api/…）
 * @param init fetch 参数（method/body 等）
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: init?.body instanceof FormData
      ? init?.headers
      : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（如字幕导出）直接透传文本 */
    if (!resp.ok) throw new ApiError(`请求失败 ${resp.status}`, resp.status);
    return text as unknown as T;
  }
  if (!resp.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `请求失败 ${resp.status}`;
    throw new ApiError(msg, resp.status);
  }
  return data as T;
}

/* ---------- 领域类型（与后端响应对应） ---------- */

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
  sourceType: 'audio' | 'video' | 'text' | 'link';
  mediaMime: string | null;
  mediaDurationMs: number | null;
  subtitleStatus: 'none' | 'processing' | 'ready' | 'failed';
  sentenceCount: number | null;
  uniqueWordCount: number | null;
  createdAt: string;
}

/** 材料（详情形态） */
export interface MaterialDetail {
  id: number;
  collectionId: number;
  title: string;
  sourceType: 'audio' | 'video' | 'text' | 'link';
  mediaPath: string | null;
  mediaMime: string | null;
  mediaDurationMs: number | null;
  subtitleStatus: 'none' | 'processing' | 'ready' | 'failed';
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
  words: Array<{ w: string; s: number; e: number; p?: number }> | null;
  isEdited: boolean;
  noteMd: string | null;
}

/** 学习进度 */
export interface ProgressDTO {
  lastPositionMs: number;
  maxCueIndex: number;
  listenedThrough: boolean;
}

/** 任务 */
export interface JobDTO {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  message: string | null;
  error: string | null;
  materialId: number | null;
  cueId: number | null;
}

/** AI 档案（掩码形态） */
export interface ProviderDTO {
  id: number;
  capability: 'stt' | 'tts' | 'align' | 'translate' | 'llm';
  name: string;
  kind: 'local' | 'cloud';
  endpointUrl: string | null;
  model: string | null;
  isDefault: boolean;
  hasKey: boolean;
}

/** 引擎能力 */
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
