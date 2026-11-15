/**
 * 档案模型清单 API：POST /api/providers/models
 * 拉取云端端点的模型列表（设置页「获取模型」按钮），供模型下拉框填充。
 * 表单未填 Key 时按档案 id 回库取（编辑模式 Key 不回显）；按档案 API 格式
 * 分发（openai-compatible / anthropic / gemini 鉴权头与字段名各不同）。
 */

import { NextResponse } from 'next/server';
import { enginePost, engineErrorResponse } from '@/lib/server/engine';
import { formKeyOrStored } from '@/lib/server/providers';
import { readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/** 允许回库取 Key 的能力白名单（模型清单 UX 实际服务的能力）；
 *  speech_eval 的 SecretKey 绝不进模型清单链路 */
const KEY_LOOKUP_CAPABILITIES = new Set(['llm', 'translate', 'stt', 'tts']);

/**
 * POST —— Body: { endpointUrl, apiKey?, profileId?, capability?, apiFormat? }
 * 返回 { models: string[] }（保持端点返回顺序）
 */
export async function POST(request: Request) {
  const body = await readJsonBody<{
    endpointUrl?: string;
    apiKey?: string;
    profileId?: number;
    /** 档案所属能力（回库取 Key 的能力限定；缺省按 llm） */
    capability?: string;
    /** LLM 档案的 API 格式（缺省=OpenAI 兼容方言） */
    apiFormat?: string;
  }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const endpointUrl = body.endpointUrl?.trim();
  if (!endpointUrl) {
    return NextResponse.json({ error: '端点 URL 不能为空' }, { status: 400 });
  }
  // Key 优先用表单值；编辑模式留空时按档案 id 回库取（Key 只进不出，接口永不回传）。
  // 回库按能力白名单限定——白名单外的能力（如 speech_eval）只用表单现值，
  // 杜绝借本路由取他能力档案已存 Key 的越权形状
  const capability = body.capability ?? 'llm';
  const apiKey = KEY_LOOKUP_CAPABILITIES.has(capability)
    ? formKeyOrStored(body.apiKey, body.profileId, capability)
    : (body.apiKey?.trim() ?? '');
  try {
    const { models } = await enginePost<{ models: string[] }>('/llm/models', {
      endpoint_url: endpointUrl,
      api_key: apiKey || null,
      api_format: body.apiFormat ?? null,
    });
    return NextResponse.json({ models });
  } catch (err) {
    return engineErrorResponse(err, '模型清单拉取失败');
  }
}
