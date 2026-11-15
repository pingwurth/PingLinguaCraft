/**
 * 链接导入 API：POST /api/import/link —— YouTube/Bilibili/TED/RSS（yt-dlp）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— Body: { url, collectionId, title?, wantVideo? }
 */
export async function POST(request: Request) {
  const body = await readJsonBody<{
    url?: string;
    collectionId?: number;
    title?: string;
    wantVideo?: boolean;
    sttProfileId?: number;
    translateProfileId?: number;
  }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const url = body.url?.trim();
  if (!url || !/^https?:\/\//.test(url)) {
    return NextResponse.json({ error: '请提供合法的 http(s) 链接' }, { status: 400 });
  }
  const db = getDb();
  const collection = db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, Number(body.collectionId)))
    .all()[0];
  if (!collection) return NextResponse.json({ error: '材料集不存在' }, { status: 404 });

  const now = new Date();
  const inserted = db
    .insert(materials)
    .values({
      userId: 1,
      collectionId: collection.id,
      title: body.title?.trim() || url.slice(0, 120),
      sourceType: 'link',
      sourceUrl: url,
      subtitleStatus: 'processing',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: materials.id })
    .all();
  const materialId = inserted[0]!.id;

  const jobId = createJob({
    type: 'import',
    materialId,
    payload: {
      kind: 'link',
      url,
      wantVideo: body.wantVideo ?? true,
      sttProfileId: body.sttProfileId,
      translateProfileId: body.translateProfileId,
    },
  });
  startPipeline(jobId);
  return NextResponse.json({ materialId, jobId }, { status: 202 });
}
