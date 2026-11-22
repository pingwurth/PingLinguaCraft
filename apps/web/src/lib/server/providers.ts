/**
 * AI 能力档案解析（provider_profiles 表 → 引擎可执行的 profile）
 *
 * 职责：按能力（stt/tts/align/translate/llm/speech_eval）解析当前生效档案：
 * 显式指定 id > 该能力默认档案 > 该能力第一个档案 > 内置本地默认（仅 stt/tts）。
 * 云端档案的 api_key 只在服务端流转，任何 API 响应都不回传。
 */

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AICapability } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { providerProfiles } from '@/lib/db/schema';
import { parseParamsJson, ttsEngineFromParams } from '@/lib/providers';

/** 解析后的可执行档案（发给引擎的形态） */
export interface ResolvedProfile {
  kind: 'local' | 'cloud';
  /** 云端端点（kind=cloud 必填） */
  endpoint_url?: string;
  /** 云端密钥（仅服务端流转） */
  api_key?: string | null;
  /** 模型名 / 本地引擎规格（如 large-v3、en-GB-RyanNeural） */
  model?: string | null;
  /** 附加参数 */
  params: Record<string, unknown>;
  /** 档案显示名（溯源展示用） */
  name: string;
  /** 档案 id（0=内置默认） */
  profileId: number;
}

/** 内置本地默认（未配置任何档案时的兜底；与引擎侧默认一致） */
const BUILTIN_DEFAULTS: Partial<Record<AICapability, ResolvedProfile>> = {
  stt: { kind: 'local', model: 'large-v3', params: {}, name: '内置 · faster-whisper', profileId: 0 },
  tts: { kind: 'local', model: 'en-GB-RyanNeural', params: {}, name: '内置 · edge-tts 英音', profileId: 0 },
};

/** 「未配置 LLM 档案」提示文案（structuredLLM、任务管线、ai/tutor、
 *  cues/imitate 四处入口共用单源——各写一份会在措辞调整时漏改其一，
 *  同一提示多个入口多种说法） */
export const LLM_PROFILE_MISSING_MESSAGE = '未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）';

/**
 * 解析能力档案
 * @param capability 能力类别
 * @param profileId 显式指定档案 id（可选；导入向导/设置页的临时切换）
 * @returns 生效档案；无可用档案（translate/llm 未配置）返回 null
 */
export function resolveProfile(
  capability: AICapability,
  profileId?: number
): ResolvedProfile | null {
  const db = getDb();
  // userId 收窄与 formKeyOrStored 同款（模块内租户口径一致；预留列约定）
  const rows = db
    .select()
    .from(providerProfiles)
    .where(and(eq(providerProfiles.capability, capability), eq(providerProfiles.userId, 1)))
    .all();

  const row =
    (profileId ? rows.find((r) => r.id === profileId) : undefined) ??
    rows.find((r) => r.isDefault) ??
    rows[0];

  if (!row) {
    // 未配置：stt/tts 有内置本地默认，其余返回 null（调用方走「未配置」分支）
    return BUILTIN_DEFAULTS[capability] ?? null;
  }

  // paramsJson 安全解析共用 lib/providers 的单一实现（与设置页展示口径一致）
  const params = parseParamsJson(row.paramsJson);
  return {
    kind: row.kind as 'local' | 'cloud',
    endpoint_url: row.endpointUrl ?? undefined,
    api_key: row.apiKey,
    model: row.model,
    params,
    name: row.name,
    profileId: row.id,
  };
}

/**
 * 档案 → 引擎请求里的精简 profile（去掉 name/profileId 等元数据）
 * @param p 完整档案
 */
export function toEngineProfile(p: ResolvedProfile): Record<string, unknown> {
  return {
    kind: p.kind,
    endpoint_url: p.endpoint_url,
    api_key: p.api_key,
    model: p.model,
    params: p.params,
  };
}

/**
 * 档案列表安全序列化（API 响应用；api_key 永不回传，只回传「是否已配置」）
 * @param rows 档案行数组
 */
export function maskProfile<T extends { apiKey: string | null }>(row: T): Omit<T, 'apiKey'> & { hasKey: boolean } {
  const { apiKey, ...rest } = row;
  return { ...rest, hasKey: Boolean(apiKey) };
}

/**
 * 表单 apiKey 或按 profileId 回库取已存 Key（编辑模式 Key 不回显；
 * 连通性测试与「获取模型」两个入口共用的兜底规则）。
 * 回库查询按 userId=1 + capability 双重限定——profileId 由客户端提交，
 * 不限定能力的话一个被他能力档案 id 指定的请求就能取到任意能力的已存
 * Key 并随测试/拉模型请求发往客户端指定的端点（凭据越权外发的形状）。
 * @param apiKey 表单现值（空白视同未填）
 * @param profileId 编辑中的档案 id（新增表单为 undefined）
 * @param capability 该请求所属能力（回库取 Key 的限定条件）
 */
export function formKeyOrStored(
  apiKey: string | undefined,
  profileId: number | undefined,
  capability: string
): string {
  // 能力是回库限定的前提：空/漏传时明确报错，不静默退化为「查不到→空 Key」
  // （那会让编辑态测试以「鉴权失败」的假象暴露）
  if (!capability) throw new Error('回库取 Key 需要能力限定参数（capability）');
  const form = apiKey?.trim() ?? '';
  if (form || !profileId) return form;
  const row = getDb()
    .select({ apiKey: providerProfiles.apiKey })
    .from(providerProfiles)
    .where(
      and(
        eq(providerProfiles.id, profileId),
        eq(providerProfiles.userId, 1),
        eq(providerProfiles.capability, capability)
      )
    )
    .all()[0];
  return row?.apiKey ?? '';
}

/**
 * 当前 TTS 档案的缓存指纹（类型 + 引擎 + 模型/音色 + 端点 → 短哈希）
 *
 * 版本化音频 URL 的 v 参数数据源：切换 TTS 档案（换引擎或音色）指纹即变，
 * 客户端按新 URL 取音频，不会命中旧音色的不可变缓存。
 * 进哈希的字段覆盖档案间所有实际差异轴，缺一则两个不同档案撞同一 v、
 * immutable 缓存互相回放对方的音频：
 * - kind + 端点：云端/本地档案、不同端点的云端档案之间隔离——仅凭
 *   engine|model 会撞车（如「未填模型的云端档案」vs「model 也空的 edge
 *   本地档案」都哈希 "edge||"）
 * - 音色来源按档案形态分两侧：本地档案音色存 model 字段；云端档案 model
 *   是模型名（默认 qwen-audio-3.0-tts-plus）、音色在 params.voice——都进哈希
 */
export function ttsProfileFingerprint(profile?: ResolvedProfile | null): string {
  // 未传档案时自行解析（version 端点等独立调用）；路由内传预解析档案，
  // 让「指纹闸门」与「合成用档案」读同一快照（各自解析存在跨快照窗口）
  const p = profile !== undefined ? profile : resolveProfile('tts');
  const cloudVoice = typeof p?.params?.voice === 'string' ? p.params.voice : '';
  return createHash('sha1')
    .update(
      `${p?.kind ?? 'local'}|${ttsEngineFromParams(p?.params)}|${p?.model ?? ''}|${cloudVoice}|${p?.endpoint_url ?? ''}`
    )
    .digest('hex')
    .slice(0, 10);
}
