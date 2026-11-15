/**
 * TTS 档案版本指纹：GET /api/media/tts/version → { v }
 *
 * 客户端（播放器点词朗读/复习听音）先取指纹再拼版本化朗读 URL，不依赖
 * 302 跳转——旧版无版本 URL 曾被钉上一年不可变缓存，切档案后浏览器直接
 * 回放磁盘旧音色、302 根本不被触及；客户端主动带 v 才是失效旧缓存的正解。
 */

import { NextResponse } from 'next/server';
import { ttsProfileFingerprint } from '@/lib/server/providers';

export const runtime = 'nodejs';

/**
 * GET —— 当前 TTS 档案（引擎+音色）的短指纹（no-store：指纹本身不可缓存）
 */
export async function GET() {
  return NextResponse.json({ v: ttsProfileFingerprint() }, { headers: { 'Cache-Control': 'no-store' } });
}
