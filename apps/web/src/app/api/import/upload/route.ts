/**
 * 本地文件导入 API：POST /api/import/upload（multipart）
 * 音频/视频文件 + 可选字幕文件（有字幕免 STT）+ 归属材料集
 */

import { NextResponse } from 'next/server';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { materialDir, extFromMime, relMediaPath } from '@/lib/server/media';

export const runtime = 'nodejs';

/** 单文件上限 2GB（局域网上传，浏览器大文件用链接导入替代） */
const MAX_SIZE = 2 * 1024 * 1024 * 1024;

/**
 * POST —— multipart: file(必), subtitle(可选 srt/vtt), collectionId(必), title?
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get('file') as File | null;
  const subtitle = form.get('subtitle') as File | null;
  const collectionId = Number(form.get('collectionId'));
  const title = (form.get('title') as string | null)?.trim() || null;
  const sttProfileId = form.get('sttProfileId') ? Number(form.get('sttProfileId')) : undefined;
  const translateProfileId = form.get('translateProfileId')
    ? Number(form.get('translateProfileId'))
    : undefined;

  if (!file || !Number.isInteger(collectionId) || collectionId <= 0) {
    return NextResponse.json({ error: '缺少 file 或 collectionId' }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: '文件超过 2GB，请改用链接导入' }, { status: 413 });
  }
  const db = getDb();
  const collection = db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .all()[0];
  if (!collection) return NextResponse.json({ error: '材料集不存在' }, { status: 404 });

  // 建材料行（先建拿 id，再落媒体文件）
  const now = new Date();
  const isVideo = (file.type || '').startsWith('video/');
  const inserted = db
    .insert(materials)
    .values({
      userId: 1,
      collectionId,
      title: title ?? file.name.replace(/\.[^.]+$/, ''),
      sourceType: isVideo ? 'video' : 'audio',
      mediaSizeBytes: file.size,
      mediaMime: file.type || null,
      subtitleStatus: 'processing',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: materials.id })
    .all();
  const materialId = inserted[0]!.id;

  // 落媒体文件
  const dir = materialDir(collectionId, materialId);
  const origExt = file.name.includes('.') ? file.name.split('.').pop()! : '';
  const ext = extFromMime(file.type, origExt);
  const mediaAbs = join(dir, `original.${ext}`);
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(mediaAbs, buf);

  // 可选字幕文件读入（管线里解析落库，免 STT）
  let subtitleText: string | undefined;
  if (subtitle && subtitle.size > 0 && subtitle.size < 5 * 1024 * 1024) {
    subtitleText = await subtitle.text();
  }

  db.update(materials)
    .set({ mediaPath: relMediaPath(mediaAbs), updatedAt: now })
    .where(eq(materials.id, materialId))
    .run();

  const jobId = createJob({
    type: 'import',
    materialId,
    payload: { kind: 'upload', mediaPath: mediaAbs, subtitleText, sttProfileId, translateProfileId },
  });
  startPipeline(jobId);
  return NextResponse.json({ materialId, jobId }, { status: 202 });
}
