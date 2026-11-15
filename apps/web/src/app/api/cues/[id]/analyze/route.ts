/**
 * 句子 AI 解析 + 收藏 API（需求 8：句子AI解析并添加收藏；需求 13：收藏可选分类）
 * POST /api/cues/[id]/analyze  Body: { categoryId? } → { favoriteId, jobId }
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues, favorites } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 创建/复用收藏并发起 AI 解析任务
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { categoryId?: number | null };
  const cueId = parseIdParam(id);
  if (cueId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();

  const cue = db.select().from(cues).where(eq(cues.id, cueId)).all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });

  // 幂等：同句已有收藏则复用（需求 13：可重新生成解析）
  let fav = db
    .select()
    .from(favorites)
    .where(and(eq(favorites.userId, 1), eq(favorites.cueId, cueId)))
    .all()[0];
  const now = new Date();
  if (!fav) {
    const r = db
      .insert(favorites)
      .values({
        userId: 1,
        cueId,
        categoryId: body.categoryId ?? null,
        aiAnalysisStatus: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: favorites.id })
      .all();
    fav = { id: r[0]!.id } as typeof fav;
  } else {
    db.update(favorites)
      .set({
        categoryId: body.categoryId ?? fav.categoryId,
        aiAnalysisStatus: 'pending',
        updatedAt: now,
      })
      .where(eq(favorites.id, fav.id))
      .run();
  }

  const jobId = createJob({ type: 'ai_analysis', cueId, payload: { favoriteId: fav.id } });
  startPipeline(jobId);
  return NextResponse.json({ favoriteId: fav.id, jobId }, { status: 202 });
}
