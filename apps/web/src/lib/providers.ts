/**
 * 档案纯逻辑（客户端/服务端共用；不引 node 专属依赖）
 *
 * paramsJson 解析与 TTS 引擎判别的单一来源：设置页（客户端）、
 * lib/server/providers（解析档案）与 TTS 相关路由（缓存指纹/状态文案）
 * 此前各持一份拷贝，键名或引擎名一变即静默分叉（错误音色缓存的温床）。
 */

/** 档案 paramsJson 安全解析（损坏/缺失按空对象处理） */
export function parseParamsJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * TTS 引擎判别（与引擎 capabilities._tts_engine 同一规则）
 * @param params 已解析的档案参数（params.engine === 'kokoro' 走本地离线，其余/缺省=edge）
 */
export function ttsEngineFromParams(params: Record<string, unknown> | undefined | null): 'edge' | 'kokoro' {
  return params?.engine === 'kokoro' ? 'kokoro' : 'edge';
}

/** 档案行/DTO 的最小形态（解析引擎所需字段） */
interface ProfileLike {
  capability: string;
  paramsJson?: string | null;
}

/**
 * TTS 档案所选引擎（paramsJson 解析；非 TTS 档案或解析失败按 edge）
 * @param p 档案行（掩码 DTO 或库表行均可）
 */
export function ttsEngineOf(p: ProfileLike): 'edge' | 'kokoro' {
  if (p.capability !== 'tts') return 'edge';
  return ttsEngineFromParams(parseParamsJson(p.paramsJson));
}
