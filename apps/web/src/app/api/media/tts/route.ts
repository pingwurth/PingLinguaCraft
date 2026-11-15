/**
 * TTS 朗读代理：GET /api/media/tts?text=…&voice=…&v=…（需求 8：点词朗读，默认英音）
 *
 * 引擎合成（内容哈希缓存；edge-tts 出 mp3 / kokoro 出 wav）→ 本路由读文件
 * 按扩展名回传。缓存策略：音频本体带不可变缓存头（同版本同 URL 浏览器可
 * 无限期复用，移动端流量友好）；但音频内容随 TTS 档案变（引擎/音色/端点），
 * URL 不带判别符的话切换档案后浏览器会一直回放旧缓存。正解是双保险：
 * 1. 客户端主动带 v=当前档案指纹（lib/ttsUrl，播放器/复习页已接）；
 * 2. 服务端校验 v 必须等于当前指纹，不符一律 302 到当期版本化 URL——
 *    不可变缓存头只发给「v=当前指纹」的请求，旧 v / 占位 v=0 / 换档案后
 *    的跨标签页残留 v 都毒化不了任何缓存条目（302 本身不缓存）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { enginePost, engineErrorResponse } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile, ttsProfileFingerprint } from '@/lib/server/providers';

export const runtime = 'nodejs';

/**
 * GET —— v 缺失或与当前档案指纹不符：302 到带当前指纹的 URL（302 不缓存）；
 * v 为当前指纹：合成（或复用缓存）并以不可变缓存头回传
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const text = (url.searchParams.get('text') ?? '').trim().slice(0, 500);
  const voice = url.searchParams.get('voice') ?? undefined;
  if (!text) return NextResponse.json({ error: '缺少 text' }, { status: 400 });

  // 档案只读一次：指纹闸门与合成共用同一快照（各调一次 resolveProfile 存在
  // 跨快照窗口——两次读取之间切档案会让闸门放行一个即将失效的 v）
  const profile = resolveProfile('tts');
  // 缓存判别符：当前 TTS 档案（类型/引擎/模型/音色/端点）的短指纹（单一来源：
  // lib/server/providers）。v 与指纹不符即重定向——这是不可变缓存头的前置闸门：
  // 档案已切换而客户端仍持旧 v（或降级占位 v=0）时，若照旧回 200+immutable，
  // 该 (text, 旧v) 条目会被新档案的音频毒化且一年无法驱逐；302 到当期版本
  // 让旧 URL 永远拿不到可缓存的实体响应
  const currentV = ttsProfileFingerprint(profile);
  if (url.searchParams.get('v') !== currentV) {
    url.searchParams.set('v', currentV);
    const redirect = NextResponse.redirect(url, 302);
    // 显式禁缓存：正确性论证依赖「302 不被缓存」，不交给浏览器默认行为
    redirect.headers.set('Cache-Control', 'no-store');
    return redirect;
  }

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
        // 走到此处必是「v=当前指纹」：同 (text, 档案版本) 恒定产物，可无限期缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return engineErrorResponse(err, '合成失败');
  }
}
