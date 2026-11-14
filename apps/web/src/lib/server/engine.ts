/**
 * AI 引擎 HTTP 客户端（web → engine，唯一调用方）
 *
 * 引擎地址：环境变量 PINGLC_ENGINE_URL（默认 http://127.0.0.1:8765）。
 * 两种调用形态：
 * - 同步端点（probe / tts / translate / llm …）：enginePost 直接等结果
 * - 长任务（stt / tts_batch / yt_download）：submitJob 拿 id → awaitJob 轮询到终态
 */

/** 引擎基础地址 */
const ENGINE_URL = process.env.PINGLC_ENGINE_URL ?? 'http://127.0.0.1:8765';

/** 引擎不可达/返回异常（消息可直接展示给用户） */
export class EngineError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码（网络失败时为 0） */
    public readonly status: number
  ) {
    super(message);
  }
}

/**
 * 引擎请求通用封装：非 2xx 抛 EngineError（带引擎 detail）
 * @param path 路径（以 / 开头）
 * @param init fetch 初始化参数
 */
async function engineFetch(path: string, init?: RequestInit): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(`${ENGINE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // 网络层异常（连接拒绝/超时）统一归为「引擎不可达」，原始异常无展示价值
    throw new EngineError(
      `AI 引擎不可达（${ENGINE_URL}）——请运行 ./scripts/start.sh engine 启动`,
      0
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text).detail ?? detail;
    } catch {
      /* 保留原文 */
    }
    throw new EngineError(`引擎错误 ${resp.status}：${detail}`, resp.status);
  }
  return resp;
}

/**
 * 引擎健康检查
 * @returns 存活返回 true；不可达返回 false（不抛错，供 UI 状态展示）
 */
export async function engineHealth(): Promise<boolean> {
  try {
    const r = await engineFetch('/health');
    return (await r.json()).status === 'ok';
  } catch {
    return false;
  }
}

/**
 * 引擎能力探测（本地引擎可用性 + GPU，驱动设置页下拉）
 */
export async function engineCapabilities(): Promise<EngineCapabilities> {
  const r = await engineFetch('/system/capabilities');
  return r.json();
}

/** 能力探测结果结构（与 engine /system/capabilities 对应） */
export interface EngineCapabilities {
  stt: { faster_whisper: boolean; whisperx: boolean };
  tts: { edge_tts: boolean; kokoro: boolean };
  align: { whisperx: boolean; mfa_docker: boolean };
  cuda: boolean;
  yt_dlp: boolean;
  ffmpeg: boolean;
}

/**
 * 同步 POST 调用
 * @param path 路径
 * @param body 请求体
 */
export async function enginePost<T>(path: string, body: unknown): Promise<T> {
  const r = await engineFetch(path, { method: 'POST', body: JSON.stringify(body) });
  return r.json();
}

/** 引擎任务快照（/jobs/{id} 返回结构） */
export interface EngineJobSnapshot {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  message: string | null;
  result: unknown;
  error: string | null;
}

/**
 * 提交引擎长任务
 * @param type 任务类型（stt / tts_batch / yt_download）
 * @param params 任务参数
 * @returns 引擎任务快照（含 id）
 */
export async function engineSubmitJob(
  type: string,
  params: Record<string, unknown>
): Promise<EngineJobSnapshot> {
  return enginePost('/jobs', { type, params });
}

/**
 * 查询引擎任务状态
 * @param id 引擎任务 id
 * @returns 快照；引擎不可达或任务不存在（404，引擎重启后内存注册表清空）返回 null
 */
export async function engineGetJob(id: string): Promise<EngineJobSnapshot | null> {
  try {
    const r = await engineFetch(`/jobs/${id}`);
    return r.json();
  } catch {
    return null;
  }
}

/**
 * 轮询等待引擎任务到终态（导入管线主循环使用）
 * @param id 引擎任务 id
 * @param opts.onProgress 进度回调（快照）；opts.pollMs 轮询间隔（默认 400ms）
 * @returns 成功时的 result；失败/取消抛 EngineError
 */
export async function engineAwaitJob(
  id: string,
  opts: { onProgress?: (s: EngineJobSnapshot) => void; pollMs?: number } = {}
): Promise<unknown> {
  const pollMs = opts.pollMs ?? 400;
  for (;;) {
    const snap = await engineGetJob(id);
    if (!snap) {
      // 引擎重启丢任务（内存注册表）——终态处理
      throw new EngineError('引擎任务丢失（引擎可能重启过），请重试', 0);
    }
    opts.onProgress?.(snap);
    if (snap.status === 'succeeded') return snap.result;
    if (snap.status === 'failed') throw new EngineError(snap.error ?? '任务失败', 500);
    if (snap.status === 'cancelled') throw new EngineError('任务已取消', 0);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
