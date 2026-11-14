/**
 * 材料集 API：GET 列表（含统计）/ POST 创建（需求 19）
 */

import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/collections —— 材料集列表（每集含材料数/总时长/研习中数）
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      cover: collections.cover,
      cefrLevel: collections.cefrLevel,
      sortOrder: collections.sortOrder,
      createdAt: collections.createdAt,
      materialCount: sql<number>`(
        SELECT count(*) FROM ${materials}
        WHERE ${materials.collectionId} = ${collections.id} AND ${materials.deletedAt} IS NULL
      )`,
      totalDurationMs: sql<number>`(
        SELECT coalesce(sum(${materials.mediaDurationMs}), 0) FROM ${materials}
        WHERE ${materials.collectionId} = ${collections.id} AND ${materials.deletedAt} IS NULL
      )`,
    })
    .from(collections)
    .where(eq(collections.userId, 1))
    .orderBy(collections.sortOrder, collections.id)
    .all();
  return NextResponse.json({ collections: rows });
}

/**
 * POST /api/collections —— 创建材料集
 * Body: { name, description?, cefrLevel? }
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    description?: string;
    cefrLevel?: string;
  };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: '材料集名不能为空' }, { status: 400 });
  const db = getDb();
  const now = new Date();
  const r = db
    .insert(collections)
    .values({
      userId: 1,
      name,
      description: body.description?.trim() || null,
      cefrLevel: body.cefrLevel || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: collections.id })
    .all();
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}
