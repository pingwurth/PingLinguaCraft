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

/**
 * 档案能力×类型校验（POST /api/providers 与 PATCH /api/providers/[id] 单一来源；
 * PATCH 传「合并后的完整档案」判断，防局部更新存入不可用档案）
 * @param capability 能力（speech_eval 有专用规则）
 * @param kind 档案类型
 * @param endpointUrl 云端端点（合并后现值）
 * @param params 档案附加参数（合并后现值；speech_eval 凭据在此）
 * @returns 错误文案；null=校验通过
 */
export function validateProfile(
  capability: string,
  kind: string,
  endpointUrl: string | null | undefined,
  params: Record<string, unknown>
): string | null {
  if (kind !== 'local' && kind !== 'cloud') return '类型必须为 local/cloud';
  if (kind === 'cloud' && !endpointUrl?.trim()) return '云端档案必须填写端点 URL';
  // 云端专属能力（引擎侧硬性要求云端形态，存成 local 即死档案）：与设置页
  // CAP_RULES 的 cloudOnly 同口径——llm/translate/speech_eval
  if (capability === 'llm' || capability === 'translate' || capability === 'speech_eval') {
    if (kind !== 'cloud') return '该能力仅支持云端档案（本地模型走 OpenAI 兼容端点地址）';
  }
  if (capability === 'speech_eval') {
    // 口语评测凭据：appId/secretId 必填且 trim 后判空（空白串不算已填），
    // SecretKey 可后补；服务地址已由上面的云端分支保证非空
    const appId = typeof params.appId === 'string' ? params.appId.trim() : '';
    const secretId = typeof params.secretId === 'string' ? params.secretId.trim() : '';
    if (!appId || !secretId) {
      return '口语评测档案必须填写服务地址、appId 与 secretId';
    }
  }
  return null;
}
