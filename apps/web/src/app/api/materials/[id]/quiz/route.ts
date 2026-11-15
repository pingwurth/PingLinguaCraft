/**
 * 测验 API（需求 12）
 * GET  /api/materials/[id]/quiz            —— 最新测验（含错题统计）
 * POST /api/materials/[id]/quiz            —— 生成新测验（LLM 任务）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, materials, quizAttempts } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';

export const runtime = 'nodejs';

/**
 * GET —— 最新可用测验（无则 { quiz: null }）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const materialId = Number(id);
  const db = getDb();
  const row = db
    .select()
    .from(aiArtifacts)
    .where(
      and(
        eq(aiArtifacts.kind, 'quiz'),
        eq(aiArtifacts.subjectType, 'material'),
        eq(aiArtifacts.subjectId, materialId)
      )
    )
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1)
    .all()[0];
  if (!row) return NextResponse.json({ quiz: null });
  const wrongCount = db
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.materialId, materialId), eq(quizAttempts.isCorrect, false)))
    .all().length;
  return NextResponse.json({
    quiz: { artifactId: row.id, provider: row.provider, createdAt: row.createdAt, data: JSON.parse(row.contentMd!) },
    wrongCount,
  });
}

/**
 * POST —— 生成新测验（管线任务；材料需已就绪）
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const materialId = Number(id);
  const db = getDb();
  const material = db
    .select({ status: materials.subtitleStatus })
    .from(materials)
    .where(eq(materials.id, materialId))
    .all()[0];
  if (!material) return NextResponse.json({ error: '材料不存在' }, { status: 404 });
  if (material.status !== 'ready') {
    return NextResponse.json({ error: '字幕未就绪，无法出题' }, { status: 400 });
  }
  const jobId = createJob({ type: 'ai_quiz', materialId });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}
