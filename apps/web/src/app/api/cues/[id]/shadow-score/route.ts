/**
 * 跟读评分 API（闯关「跟读评分/影子跟读」玩法共用）
 * POST /api/cues/[id]/shadow-score  body = 录音音频字节
 * 评分方式：录音经引擎 STT 转写 → 与目标句 diffSentence 词级相似度 → 0~100 分
 * （音素级对齐评分 M4+ 接入 WhisperX/MFA 后升级，此为可离线可用的代理评分）
 */

import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { diffSentence } from '@pinglc/core';
import { eq } from 'drizzle-orm';
import { getDb, PINGLC_HOME } from '@/lib/db';
import { cues } from '@/lib/db/schema';
import { EngineError, enginePost } from '@/lib/server/engine';
import { toEngineProfile } from '@/lib/server/providers';

export const runtime = 'nodejs';

/** 评分录音上限 5MB */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST —— body = audio blob（webm/mp4）；返回 { score, heard, diff }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cueId = Number(id);
  const db = getDb();
  const cue = db.select().from(cues).where(eq(cues.id, cueId)).all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: '录音为空' }, { status: 400 });
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: '录音过大' }, { status: 413 });

  // 临时文件（评分不留存）：独立 tmp 目录，不混入引擎的内容哈希缓存；
  // mkdirSync 幂等——引擎未启动过也能评分
  const tmpDir = join(PINGLC_HOME, 'tmp');
  const tmpPath = join(tmpDir, `shadow-${cueId}-${Date.now()}.webm`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpPath, buf);
    // 引擎同步 STT（短音频）；评分固定用 base 小模型（快、且与生成转写档案解耦）
    const sttProfile = toEngineProfile({
      kind: 'local',
      params: {},
      name: '评分',
      profileId: 0,
      model: 'base',
    });
    const result = await enginePost<{ words: Array<{ w: string }> }>('/stt', {
      audio_path: tmpPath,
      profile: sttProfile,
      language: 'en',
    });
    const heard = (result.words ?? []).map((w) => w.w).join(' ').trim();
    if (!heard) {
      return NextResponse.json({ score: 0, heard: '', diff: null, note: '未识别到语音（声音太小或环境嘈杂）' });
    }
    const diff = diffSentence(cue.textEn, heard);
    return NextResponse.json({
      score: Math.round(diff.score * 100),
      heard,
      diff: { items: diff.items.map((x) => ({ target: x.target, typed: x.typed, status: x.status })), exact: diff.exact },
    });
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '评分失败';
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 清理失败无害 */
    }
  }
}
