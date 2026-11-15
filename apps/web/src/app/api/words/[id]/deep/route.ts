/**
 * 单词深学卡 API（M4：词源拓扑 + 仿写构架）
 * POST /api/words/[id]/deep —— 生成任务（幂等：已有则 force 才重生成）
 * GET  /api/words/[id]/deep —— 最新深学数据（词源树 + 构架）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, words } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 发起深学卡生成
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const db = getDb();
  const word = db.select({ id: words.id }).from(words).where(eq(words.id, wordId)).all()[0];
  if (!word) return NextResponse.json({ error: '单词不存在' }, { status: 404 });

  // 幂等：已有词源与构架且未要求 force → 直接返回已有
  if (!body.force) {
    const w = db.select({ etymologyJson: words.etymologyJson }).from(words).where(eq(words.id, wordId)).all()[0];
    const frames = db
      .select({ id: aiArtifacts.id })
      .from(aiArtifacts)
      .where(and(eq(aiArtifacts.kind, 'imitation'), eq(aiArtifacts.subjectType, 'word'), eq(aiArtifacts.subjectId, wordId)))
      .all()[0];
    if (w?.etymologyJson && frames) {
      return NextResponse.json({ cached: true });
    }
  }

  const jobId = createJob({ type: 'deep_card', payload: { wordId } });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}

/**
 * GET —— 最新深学数据
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const w = db
    .select({ etymologyJson: words.etymologyJson })
    .from(words)
    .where(eq(words.id, pid))
    .all()[0];
  const frames = db
    .select({ contentMd: aiArtifacts.contentMd, createdAt: aiArtifacts.createdAt })
    .from(aiArtifacts)
    .where(and(eq(aiArtifacts.kind, 'imitation'), eq(aiArtifacts.subjectType, 'word'), eq(aiArtifacts.subjectId, pid)))
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1)
    .all()[0];
  return NextResponse.json({
    etymology: w?.etymologyJson ? JSON.parse(w.etymologyJson) : null,
    frames: frames?.contentMd ? JSON.parse(frames.contentMd) : null,
  });
}
