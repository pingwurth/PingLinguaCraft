/**
 * 档案连通性测试 API：POST /api/providers/test
 * 按能力做最小真实调用（llm/translate 一句话；stt/tts 走引擎探测）
 */

import { NextResponse } from 'next/server';
import { enginePost } from '@/lib/server/engine';

export const runtime = 'nodejs';

/**
 * POST —— Body: { capability, endpointUrl?, apiKey?, model?, voice? }
 * 返回 { ok, detail }（detail 为模型回复或错误信息）
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    capability?: string;
    endpointUrl?: string;
    apiKey?: string;
    model?: string;
  };
  const profile = {
    kind: 'cloud' as const,
    endpoint_url: body.endpointUrl,
    api_key: body.apiKey,
    model: body.model,
    params: {},
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
