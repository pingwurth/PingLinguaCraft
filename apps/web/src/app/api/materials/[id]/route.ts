/**
 * 单个材料 API：GET 详情（含学习进度，播放页装载）/ PATCH / DELETE 软删
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { learningProgress, materials } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET /api/materials/[id] —— 材料详情 + 学习进度
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const row = db.select().from(materials).where(eq(materials.id, pid)).all()[0];
  if (!row || row.deletedAt) return NextResponse.json({ error: '材料不存在' }, { status: 404 });
  const progress = db
    .select()
    .from(learningProgress)
    .where(eq(learningProgress.materialId, row.id))
    .all()[0] ?? null;
  return NextResponse.json({ material: row, progress });
}

/**
 * PATCH /api/materials/[id] —— 更新标题/描述/所属集
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json()) as Record<string, unknown>;
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ['title', 'description'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.collectionId !== undefined) patch.collectionId = Number(body.collectionId);
  db.update(materials).set(patch).where(eq(materials.id, pid)).run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/materials/[id] —— 软删除（保留媒体可恢复；永久清理在 M2 的存储管理页）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  db.update(materials)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(materials.id, pid))
    .run();
  return NextResponse.json({ ok: true });
}
