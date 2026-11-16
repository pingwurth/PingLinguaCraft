/**
 * 本地文件导入 API：POST /api/import/upload（multipart）
 * 音频/视频文件 + 可选字幕文件（有字幕免 STT）+ 归属材料集
 *
 * 内存纪律：媒体文件经 file.stream() 管道写盘（不二次全量进内存、不阻塞
 * 事件循环）；Content-Length 前置闸在解析前拒绝超限请求。已知余留：
 * request.formData() 在 Node 侧本身将整个 multipart 缓存在内存一份——
 * 2GB 上限对应约 2GB 峰值 RSS，单用户局域网可接受；更大文件走链接导入。
 */

import { NextResponse } from 'next/server';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
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
  // 前置体积闸（Content-Length 含 multipart 开销，放 1MiB 余量）：在 formData
  // 解析之前拒绝，注定超限的请求不再把整个 body 白白读进内存
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_SIZE + 1024 * 1024) {
    return NextResponse.json({ error: '文件超过 2GB，请改用链接导入' }, { status: 413 });
  }
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

  // 落媒体文件：file.stream() 管道写盘——旧实现 Buffer.from(arrayBuffer())
  // 把整份文件二次复制进内存且 writeFileSync 同步写阻塞事件循环（2GB 文件
  // 卡死全部请求几十秒）；流式写增量落盘，内存占用≈单块缓冲
  const dir = materialDir(collectionId, materialId);
  const origExt = file.name.includes('.') ? file.name.split('.').pop()! : '';
  const ext = extFromMime(file.type, origExt);
  const mediaAbs = join(dir, `original.${ext}`);
  try {
    await pipeline(
      Readable.fromWeb(file.stream() as unknown as NodeWebReadableStream<Uint8Array>),
      createWriteStream(mediaAbs),
    );
  } catch (err) {
    // 落盘失败补偿：删掉刚建的材料行（此时尚无 cues/媒体引用，删行无级联面），
    // 避免留下「processing 却无文件」的孤儿材料；错误信息可读化
    db.delete(materials).where(eq(materials.id, materialId)).run();
    return NextResponse.json(
      { error: `媒体文件写入失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  // 可选字幕文件读入（管线里解析落库，免 STT）
  let subtitleText: string | undefined;
  if (subtitle && subtitle.size > 0 && subtitle.size < 5 * 1024 * 1024) {
    subtitleText = await subtitle.text();
  }

  // 越界路径不落库（死材料：/api_media 收窄检查会拒发）
  const rel = relMediaPath(mediaAbs);
  if (rel === null) {
    return NextResponse.json({ error: '媒体路径越界' }, { status: 500 });
  }
  db.update(materials)
    .set({ mediaPath: rel, updatedAt: now })
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
