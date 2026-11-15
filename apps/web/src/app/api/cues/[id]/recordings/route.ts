/**
 * 跟读录音 API（需求 11：录音、播放录音）
 * GET  /api/cues/[id]/recordings           —— 该句的录音列表
 * POST /api/cues/[id]/recordings?durationMs=… —— 上传录音（body = webm 音频字节）
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { cues, materials, recordings } from '@/lib/db/schema';
import { relMediaPath } from '@/lib/server/media';

export const runtime = 'nodejs';

/** 单条录音上限 30MB（跟读单句远小于此） */
const MAX_BYTES = 30 * 1024 * 1024;

/**
 * GET —— 录音列表（新→旧）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const rows = db
    .select({
      id: recordings.id,
      durationMs: recordings.durationMs,
      createdAt: recordings.createdAt,
      filePath: recordings.filePath,
    })
    .from(recordings)
    .where(eq(recordings.cueId, Number(id)))
    .all()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return NextResponse.json({ recordings: rows });
}

/**
 * POST —— 上传录音（MediaRecorder；时长由客户端实测上报，mime 决定扩展名——Safari 是 mp4）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cueId = Number(id);
  const url = new URL(request.url);
  const durationMs = Math.max(0, Number(url.searchParams.get('durationMs') ?? '0'));
  // 客户端声明的真实 MIME（webm/opus 或 Safari 的 mp4）；空 body 的 Content-Type 兜底
  const mime = (url.searchParams.get('mime') || request.headers.get('content-type') || 'audio/webm')
    .split(';')[0]!
    .trim();
  const db = getDb();

  const cue = db
    .select({ materialId: cues.materialId })
    .from(cues)
    .where(eq(cues.id, cueId))
    .all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });
  const material = db
    .select({ collectionId: materials.collectionId })
    .from(materials)
    .where(eq(materials.id, cue.materialId))
    .all()[0];
  if (!material) return NextResponse.json({ error: '材料不存在' }, { status: 404 });

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: '录音为空' }, { status: 400 });
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: '录音过大' }, { status: 413 });

  // 存文件：media/{cid}/{mid}/rec/{cueId}-{时间戳}.{webm|mp4}（扩展名随真实 mime）
  const recDir = join(MEDIA_ROOT, String(material.collectionId), String(cue.materialId), 'rec');
  mkdirSync(recDir, { recursive: true });
  const ext = mime === 'audio/mp4' || mime === 'audio/aac' ? 'mp4' : 'webm';
  const fileName = `${cueId}-${Date.now()}.${ext}`;
  const abs = join(recDir, fileName);
  writeFileSync(abs, buf);

  const r = db
    .insert(recordings)
    .values({
      userId: 1,
      materialId: cue.materialId,
      cueId,
      filePath: relMediaPath(abs),
      durationMs: durationMs || null,
      createdAt: new Date(),
    })
    .returning({ id: recordings.id })
    .all();
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}
