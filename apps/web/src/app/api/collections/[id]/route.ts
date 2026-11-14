/**
 * 单个材料集 API：GET 详情 / PATCH 更新 / DELETE 删除（级联删材料与媒体由前端确认）
 */

import { NextResponse } from 'next/server';
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/collections/[id] —— 材料集详情
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .select()
    .from(collections)
    .where(and(eq(collections.id, Number(id)), eq(collections.userId, 1)))
    .all()[0];
  if (!row) return NextResponse.json({ error: '材料集不存在' }, { status: 404 });
  return NextResponse.json({ collection: row });
}

/**
 * PATCH /api/collections/[id] —— 更新材料集（name/description/cover/cefrLevel/sortOrder）
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ['name', 'description', 'cover', 'cefrLevel'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder);
  db.update(collections)
    .set(patch)
    .where(and(eq(collections.id, Number(id)), eq(collections.userId, 1)))
    .run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/collections/[id] —— 删除材料集（物理删：SQLite 级联清 cues 等；媒体目录一并清理）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const cid = Number(id);
  // 先收集媒体目录信息（级联删除后无法再查）
  const mats = db
    .select({ id: materials.id })
    .from(materials)
    .where(eq(materials.collectionId, cid))
    .all();
  db.delete(collections).where(and(eq(collections.id, cid), eq(collections.userId, 1))).run();
  // 清理媒体目录（best-effort；库行已删，目录残留无害但占磁盘）
  for (const m of mats) {
    try {
      rmSync(`${MEDIA_ROOT}/${cid}/${m.id}`, { recursive: true, force: true });
    } catch {
      /* 目录缺失/权限问题忽略 */
    }
  }
  try {
    rmSync(`${MEDIA_ROOT}/${cid}`, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  return NextResponse.json({ ok: true });
}
