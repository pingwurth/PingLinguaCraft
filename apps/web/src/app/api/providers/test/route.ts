/**
 * 档案连通性测试 API：POST /api/providers/test
 * 按能力做最小真实调用（llm 一句话 / translate 一句翻译）。
 * Key 优先用表单现值；编辑模式留空时按 profileId 回库取（Key 只进不出，接口永不回传）。
 */

import { NextResponse } from 'next/server';
import { enginePost } from '@/lib/server/engine';
import { formKeyOrStored } from '@/lib/server/providers';

export const runtime = 'nodejs';

/**
 * POST —— Body: { capability, endpointUrl?, apiKey?, model?, params?, profileId? }
 * params 随表单透传（LLM 的 apiFormat 等，测试与实际调用走同一格式分发）
 * 返回 { ok, detail }（detail 为模型回复或错误信息）
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    capability?: string;
    endpointUrl?: string;
    apiKey?: string;
    model?: string;
    params?: Record<string, unknown>;
    profileId?: number;
  };
  // Key 优先用表单值；编辑模式留空时按档案 id 回库取（Key 只进不出，接口永不回传）
  const apiKey = formKeyOrStored(body.apiKey, body.profileId);
  const profile = {
    kind: 'cloud' as const,
    endpoint_url: body.endpointUrl,
    api_key: apiKey,
    model: body.model,
    params: body.params ?? {},
  };
  const t0 = Date.now();
  try {
    if (body.capability === 'llm') {
      const { content } = await enginePost<{ content: string | null }>('/llm/chat', {
        profile,
        user: '请只回复两个字：在线',
        temperature: 0,
      });
      return NextResponse.json({
        ok: true,
        detail: `模型回复「${(content ?? '').slice(0, 20)}」（${Date.now() - t0}ms）`,
      });
    }
    if (body.capability === 'translate') {
      const { translations } = await enginePost<{ translations: string[] }>('/translate', {
        texts: ['Stay hungry, stay foolish.'],
        profile,
        direction: 'en2zh',
      });
      return NextResponse.json({
        ok: true,
        detail: `译文「${translations[0] ?? ''}」（${Date.now() - t0}ms）`,
      });
    }
    return NextResponse.json({ error: '该能力暂不支持在线测试' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '测试失败';
    return NextResponse.json({ ok: false, detail: msg }, { status: 502 });
  }
}
