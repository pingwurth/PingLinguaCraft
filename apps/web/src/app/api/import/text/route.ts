/**
 * 文本导入 API：POST /api/import/text —— 文本 → 分句 → cues（无时间轴）→ TTS 管线
 */

import { NextResponse } from 'next/server';
import { splitSentences } from '@pinglc/core';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, cues, materials } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';

export const runtime = 'nodejs';

/**
 * POST —— Body: { text, collectionId, title?, ttsProfileId?, translateProfileId? }
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    text?: string;
    collectionId?: number;
    title?: string;
    ttsProfileId?: number;
    translateProfileId?: number;
  };
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: '文本不能为空' }, { status: 400 });
  const db = getDb();
  const collection = db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, Number(body.collectionId)))
    .all()[0];
  if (!collection) return NextResponse.json({ error: '材料集不存在' }, { status: 404 });

  // core 分句（文本导入路径）
  const sentences = splitSentences(text);
  if (sentences.length === 0) return NextResponse.json({ error: '未切出有效句子' }, { status: 400 });

  const now = new Date();
  const inserted = db
    .insert(materials)
    .values({
      userId: 1,
      collectionId: collection.id,
      title: body.title?.trim() || text.slice(0, 40),
      sourceType: 'text',
      subtitleStatus: 'processing',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: materials.id })
    .all();
  const materialId = inserted[0]!.id;

  // 无时间轴 cues（管线 TTS 完成后回填）
  db.insert(cues).values(
    sentences.map((s, i) => ({
      userId: 1,
      materialId,
      index: i,
      startMs: 0,
      endMs: 0,
      textEn: s,
      createdAt: now,
      updatedAt: now,
    }))
  ).run();

  const jobId = createJob({
    type: 'import',
    materialId,
    payload: {
      kind: 'text',
      ttsProfileId: body.ttsProfileId,
      translateProfileId: body.translateProfileId,
    },
  });
  startPipeline(jobId);
  return NextResponse.json({ materialId, jobId, sentenceCount: sentences.length }, { status: 202 });
}
