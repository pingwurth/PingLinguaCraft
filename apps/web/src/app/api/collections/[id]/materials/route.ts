/**
 * 材料集内材料分页列表 API（需求 19：支持分页查询）
 * GET /api/collections/[id]/materials?page=1&pageSize=20&status=ready
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { materials } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET —— 分页材料列表（软删过滤；subtitle_status 过滤可选）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20')));
  const status = url.searchParams.get('status');

  const db = getDb();
  const where = and(
    eq(materials.collectionId, Number(id)),
    isNull(materials.deletedAt),
    status ? eq(materials.subtitleStatus, status) : undefined
  );

  const total = db.select({ n: sql<number>`count(*)` }).from(materials).where(where).all()[0]!.n;
  const rows = db
    .select({
      id: materials.id,
      title: materials.title,
      sourceType: materials.sourceType,
      mediaMime: materials.mediaMime,
      mediaDurationMs: materials.mediaDurationMs,
      subtitleStatus: materials.subtitleStatus,
      sentenceCount: materials.sentenceCount,
      uniqueWordCount: materials.uniqueWordCount,
      createdAt: materials.createdAt,
    })
    .from(materials)
    .where(where)
    .orderBy(desc(materials.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return NextResponse.json({
    materials: rows,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}
