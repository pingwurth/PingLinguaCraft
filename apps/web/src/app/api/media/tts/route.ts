/**
 * TTS 朗读代理：GET /api/media/tts?text=…&voice=…（需求 8：点词朗读，默认英音）
 *
 * 引擎合成（内容哈希缓存）→ 本路由读文件回传，带不可变缓存头——
 * 同词二次点击零成本，移动端流量友好。
 */

import { readFileSync, existsSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { enginePost, EngineError } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile } from '@/lib/server/providers';

export const runtime = 'nodejs';

/**
 * GET —— 合成（或复用缓存）并回传 mp3
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const text = (url.searchParams.get('text') ?? '').trim().slice(0, 500);
  const voice = url.searchParams.get('voice') ?? undefined;
  if (!text) return NextResponse.json({ error: '缺少 text' }, { status: 400 });

  const profile = resolveProfile('tts');
  try {
    const { path } = await enginePost<{ path: string }>('/tts', {
      text,
      voice,
      profile: profile ? toEngineProfile(profile) : {},
    });
    if (!existsSync(path)) return NextResponse.json({ error: '合成产物缺失' }, { status: 500 });
    const data = readFileSync(path);
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(data.length),
        // 同 (text, voice) 恒定产物：浏览器可无限期缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '合成失败';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
