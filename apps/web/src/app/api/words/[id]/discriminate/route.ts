/**
 * 辨析矩阵 API（研习手册，设计稿 _7 文人辨析矩阵）
 * POST /api/words/[id]/discriminate —— 生成任务（幂等：已有且未 force 则直接返回）
 * GET  /api/words/[id]/discriminate —— 最新辨析矩阵（近义词侧重对比）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, words } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 发起辨析矩阵生成
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const db = getDb();
  const word = db.select({ id: words.id }).from(words).where(eq(words.id, wordId)).all()[0];
  if (!word) return NextResponse.json({ error: '单词不存在' }, { status: 404 });

  // 幂等：已有矩阵且未要求 force → 直接返回已有
  if (!body.force) {
    const exist = db
      .select({ id: aiArtifacts.id })
      .from(aiArtifacts)
      .where(and(eq(aiArtifacts.kind, 'discriminate'), eq(aiArtifacts.subjectType, 'word'), eq(aiArtifacts.subjectId, wordId)))
      .all()[0];
    if (exist) return NextResponse.json({ cached: true });
  }

  const jobId = createJob({ type: 'discriminate', payload: { wordId } });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}

/**
 * GET —— 最新辨析矩阵
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const row = db
    .select({ contentMd: aiArtifacts.contentMd })
    .from(aiArtifacts)
    .where(and(eq(aiArtifacts.kind, 'discriminate'), eq(aiArtifacts.subjectType, 'word'), eq(aiArtifacts.subjectId, wordId)))
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1)
    .all()[0];
  // contentMd 是共享自由文本列，坏行（截断/手改）按「尚未生成」空态处理而非 500
  let matrix = null;
  if (row?.contentMd) {
    try {
      matrix = JSON.parse(row.contentMd);
    } catch {
      matrix = null;
    }
  }
  return NextResponse.json({ matrix });
}
