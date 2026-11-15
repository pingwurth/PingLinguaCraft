/**
 * TTS 朗读代理：GET /api/media/tts?text=…&voice=…&v=…（需求 8：点词朗读，默认英音）
 *
 * 引擎合成（内容哈希缓存；edge-tts 出 mp3 / kokoro 出 wav）→ 本路由读文件
 * 按扩展名回传。缓存策略：音频本体带不可变缓存头（同版本同 URL 浏览器可
 * 无限期复用，移动端流量友好）；但音频内容随 TTS 档案变（引擎/音色），
 * URL 不带判别符的话切换档案后浏览器会一直回放旧缓存。正解是客户端主动带
 * v=当前档案指纹（lib/ttsUrl，播放器/复习页已接）；无 v 的请求仍 302 到
 * 版本化 URL 兜底（302 不缓存，每次播放都重定到当期版本）——但注意 302
 * 对「升级前已钉入磁盘的旧缓存条目」无能为力，新客户端不要依赖它。
 */

import { readFileSync, existsSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { enginePost, EngineError } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile, ttsProfileFingerprint } from '@/lib/server/providers';

export const runtime = 'nodejs';

/**
 * GET —— 无 v：302 到带当前档案指纹的 URL；有 v：合成（或复用缓存）并回传
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const text = (url.searchParams.get('text') ?? '').trim().slice(0, 500);
  const voice = url.searchParams.get('voice') ?? undefined;
  if (!text) return NextResponse.json({ error: '缺少 text' }, { status: 400 });

  // 缓存判别符：当前 TTS 档案（引擎 + 音色）的短指纹。v 仅作客户端缓存键，
  // 服务端始终以当前档案为准合成（指纹计算在 lib/server/providers 单一来源）
  if (!url.searchParams.get('v')) {
    url.searchParams.set('v', ttsProfileFingerprint());
    return NextResponse.redirect(url, 302);
  }

  const profile = resolveProfile('tts');
  try {
    const { path } = await enginePost<{ path: string }>('/tts', {
      text,
      voice,
      profile: profile ? toEngineProfile(profile) : {},
    });
    if (!existsSync(path)) return NextResponse.json({ error: '合成产物缺失' }, { status: 500 });
    const data = readFileSync(path);
    // 引擎按 TTS 引擎落不同格式：edge-tts=mp3 / kokoro=wav，按扩展名回 Content-Type
    const contentType = path.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        // 同 (text, 档案版本) 恒定产物：版本化 URL（v=档案指纹）可无限期缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '合成失败';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
