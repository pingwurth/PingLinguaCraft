/**
 * 收藏 API：GET 列表 / POST 手动收藏句段（需求 13）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues, favoriteCategories, favorites, materials } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/favorites?categoryId= —— 收藏列表（带原句、出处材料、分类）
 */
export async function GET(request: Request) {
  const categoryId = new URL(request.url).searchParams.get('categoryId');
  const db = getDb();
  const rows = db
    .select({
      id: favorites.id,
      cueId: favorites.cueId,
      categoryId: favorites.categoryId,
      aiAnalysisMd: favorites.aiAnalysisMd,
      aiAnalysisStatus: favorites.aiAnalysisStatus,
      noteMd: favorites.noteMd,
      createdAt: favorites.createdAt,
      textEn: cues.textEn,
      textZh: cues.textZh,
      startMs: cues.startMs,
      materialId: cues.materialId,
      materialTitle: materials.title,
    })
    .from(favorites)
    .leftJoin(cues, eq(favorites.cueId, cues.id))
    .leftJoin(materials, eq(cues.materialId, materials.id))
    .where(
      categoryId
        ? and(eq(favorites.userId, 1), eq(favorites.categoryId, Number(categoryId)))
        : eq(favorites.userId, 1)
    )
    .orderBy(desc(favorites.createdAt))
    .all();
  const cats = db
    .select()
    .from(favoriteCategories)
    .where(eq(favoriteCategories.userId, 1))
    .orderBy(favoriteCategories.sortOrder)
    .all();
  return NextResponse.json({ favorites: rows, categories: cats });
}

/**
 * POST —— 手动收藏（不触发 AI 解析）；Body: { cueId, categoryId?, noteMd? }
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { cueId?: number; categoryId?: number | null; noteMd?: string };
  if (!body.cueId) return NextResponse.json({ error: '缺少 cueId' }, { status: 400 });
  const db = getDb();
  const dup = db
    .select({ id: favorites.id })
    .from(favorites)
    .where(and(eq(favorites.userId, 1), eq(favorites.cueId, body.cueId)))
    .all()[0];
  if (dup) return NextResponse.json({ id: dup.id, duplicate: true });
  const now = new Date();
  // 先查后插在并发双击下会撞 uq_favorites_cue：UNIQUE 冲突按重复收藏收敛而非 500
  let r: { id: number }[];
  try {
    r = db
      .insert(favorites)
      .values({
        userId: 1,
        cueId: body.cueId,
        categoryId: body.categoryId ?? null,
        noteMd: body.noteMd ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: favorites.id })
      .all();
  } catch (err) {
    if (!String(err).includes('UNIQUE')) throw err;
    const again = db
      .select({ id: favorites.id })
      .from(favorites)
      .where(and(eq(favorites.userId, 1), eq(favorites.cueId, body.cueId)))
      .all()[0];
    return NextResponse.json({ id: again?.id, duplicate: true });
  }
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}
