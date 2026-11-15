/**
 * AI 关卡页 API（需求 8：关卡生成——AI 针对单句生成闯关交互网页）
 * POST /api/cues/[id]/level —— 生成任务（产物为自包含 HTML）
 * GET  /api/cues/[id]/level —— 该句最新关卡（返回产物 id，经 /artifacts/[id] 渲染）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, cues } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 发起关卡生成（幂等：已有产物时 force=1 才重生成）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cueId = parseIdParam(id);
  if (cueId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const db = getDb();

  const cue = db.select({ id: cues.id }).from(cues).where(eq(cues.id, cueId)).all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });

  if (!body.force) {
    const existing = db
      .select({ id: aiArtifacts.id })
      .from(aiArtifacts)
      .where(and(eq(aiArtifacts.kind, 'level_page'), eq(aiArtifacts.subjectType, 'cue'), eq(aiArtifacts.subjectId, cueId)))
      .orderBy(desc(aiArtifacts.createdAt))
      .limit(1)
      .all()[0];
    if (existing) return NextResponse.json({ artifactId: existing.id, cached: true });
  }

  const jobId = createJob({ type: 'ai_level', cueId, payload: {} });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}

/**
 * GET —— 最新关卡产物 id（无则 null）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const row = db
    .select({ id: aiArtifacts.id, createdAt: aiArtifacts.createdAt })
    .from(aiArtifacts)
    .where(and(eq(aiArtifacts.kind, 'level_page'), eq(aiArtifacts.subjectType, 'cue'), eq(aiArtifacts.subjectId, pid)))
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1)
    .all()[0];
  return NextResponse.json({ artifact: row ?? null });
}
