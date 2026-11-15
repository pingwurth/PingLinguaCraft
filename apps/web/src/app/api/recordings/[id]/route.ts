/**
 * 单条录音：DELETE 删除 / GET 音频流（webm 回放）
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { recordings } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET —— 录音文件回传（跟读录音通常 <1MB，直接整读；Content-Type 按扩展名，
 * Safari 录的 mp4 不能标成 webm，否则移动端无法解码回放）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .select({ filePath: recordings.filePath })
    .from(recordings)
    .where(eq(recordings.id, Number(id)))
    .all()[0];
  if (!row?.filePath) return NextResponse.json({ error: '录音不存在' }, { status: 404 });
  const abs = join(MEDIA_ROOT, row.filePath);
  if (!existsSync(abs)) return NextResponse.json({ error: '录音文件缺失' }, { status: 404 });
  const data = readFileSync(abs);
  const mime = abs.endsWith('.mp4') ? 'audio/mp4' : 'audio/webm';
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(data.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

/**
 * DELETE —— 删除录音（连带文件）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .select({ filePath: recordings.filePath })
    .from(recordings)
    .where(eq(recordings.id, Number(id)))
    .all()[0];
  if (row?.filePath) {
    try {
      unlinkSync(join(MEDIA_ROOT, row.filePath));
    } catch {
      /* 文件缺失无害 */
    }
  }
  db.delete(recordings).where(eq(recordings.id, Number(id))).run();
  return NextResponse.json({ ok: true });
}
