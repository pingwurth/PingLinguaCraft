/**
 * AI 能力档案解析（provider_profiles 表 → 引擎可执行的 profile）
 *
 * 职责：按能力（stt/tts/align/translate/llm）解析当前生效档案：
 * 显式指定 id > 该能力默认档案 > 该能力第一个档案 > 内置本地默认（仅 stt/tts）。
 * 云端档案的 api_key 只在服务端流转，任何 API 响应都不回传。
 */

import { eq } from 'drizzle-orm';
import type { AICapability } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { providerProfiles } from '@/lib/db/schema';

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
  const rows = db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.capability, capability))
    .all();

  const row =
    (profileId ? rows.find((r) => r.id === profileId) : undefined) ??
    rows.find((r) => r.isDefault) ??
    rows[0];

  if (!row) {
    // 未配置：stt/tts 有内置本地默认，其余返回 null（调用方走「未配置」分支）
    return BUILTIN_DEFAULTS[capability] ?? null;
  }

  let params: Record<string, unknown> = {};
  if (row.paramsJson) {
    try {
      params = JSON.parse(row.paramsJson) as Record<string, unknown>;
    } catch {
      /* 参数损坏按空处理 */
    }
  }
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
