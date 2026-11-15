/**
 * 单收藏 API：PATCH（改分类/笔记）/ DELETE / 重新生成解析（POST ?action=reanalyze）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { favorites } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam, readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * PATCH —— Body: { categoryId?, noteMd? }
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = await readJsonBody<{ categoryId?: number | null; noteMd?: string | null }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId;
  if (body.noteMd !== undefined) patch.noteMd = body.noteMd;
  const db = getDb();
  db.update(favorites).set(patch).where(eq(favorites.id, pid)).run();
  return NextResponse.json({ ok: true });
}

/**
 * POST ?action=reanalyze —— 重新生成 AI 解析（需求 13）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const action = new URL(request.url).searchParams.get('action');
  if (action !== 'reanalyze') {
    return NextResponse.json({ error: '未知操作（支持 action=reanalyze）' }, { status: 400 });
  }
  const db = getDb();
  const fav = db.select().from(favorites).where(eq(favorites.id, pid)).all()[0];
  if (!fav) return NextResponse.json({ error: '收藏不存在' }, { status: 404 });
  db.update(favorites)
    .set({ aiAnalysisStatus: 'pending', updatedAt: new Date() })
    .where(eq(favorites.id, fav.id))
    .run();
  const jobId = createJob({ type: 'ai_analysis', cueId: fav.cueId, payload: { favoriteId: fav.id } });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}

/**
 * DELETE —— 取消收藏
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  db.delete(favorites).where(eq(favorites.id, pid)).run();
  return NextResponse.json({ ok: true });
}
