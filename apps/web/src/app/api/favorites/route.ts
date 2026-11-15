/**
 * 收藏 API：GET 列表 / POST 手动收藏句段（需求 13）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { getDb } from '@/lib/db';
import { cues, favoriteCategories, favorites, materials } from '@/lib/db/schema';
import { favoriteSnapshotOf } from '@/lib/server/favorites';
import { readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET /api/favorites?categoryId= —— 收藏列表（带原句、出处材料、分类）
 */
export async function GET(request: Request) {
  const categoryId = new URL(request.url).searchParams.get('categoryId');
  const db = getDb();
  // live 优先、快照兜底：cue 存活时文本跟随工坊纠错实时变化；cue 消亡
  // （重 STT/重导入的删旧插新、单句删除）后 cueId 置空，文本走收藏时快照
  const mLive = alias(materials, 'm_live');
  const mSnap = alias(materials, 'm_snap');
  const rows = db
    .select({
      id: favorites.id,
      cueId: favorites.cueId,
      categoryId: favorites.categoryId,
      aiAnalysisMd: favorites.aiAnalysisMd,
      aiAnalysisStatus: favorites.aiAnalysisStatus,
      noteMd: favorites.noteMd,
      createdAt: favorites.createdAt,
      textEn: sql<string | null>`coalesce(${cues.textEn}, ${favorites.textEn})`,
      textZh: sql<string | null>`coalesce(${cues.textZh}, ${favorites.textZh})`,
      startMs: cues.startMs,
      materialId: sql<number | null>`coalesce(${cues.materialId}, ${favorites.materialId})`,
      materialTitle: sql<string | null>`coalesce(${mLive.title}, ${mSnap.title})`,
    })
    .from(favorites)
    .leftJoin(cues, eq(favorites.cueId, cues.id))
    .leftJoin(mLive, eq(cues.materialId, mLive.id))
    .leftJoin(mSnap, eq(favorites.materialId, mSnap.id))
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
  const body = await readJsonBody<{ cueId?: number; categoryId?: number | null; noteMd?: string }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const cueId = body.cueId;
  if (typeof cueId !== 'number' || !Number.isInteger(cueId) || cueId <= 0) {
    return NextResponse.json({ error: '缺少或非法 cueId' }, { status: 400 });
  }
  const db = getDb();
  // 收藏时写快照（原句/译文/出处材料）：cue 消亡后收藏仍可完整展示；
  // 字段清单由 favoriteSnapshotOf 单一来源（与 analyze 收藏路径共用）
  const cue = db
    .select({ textEn: cues.textEn, textZh: cues.textZh, materialId: cues.materialId })
    .from(cues)
    .where(eq(cues.id, cueId))
    .all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 400 });
  const dup = db
    .select({ id: favorites.id })
    .from(favorites)
    .where(and(eq(favorites.userId, 1), eq(favorites.cueId, cueId)))
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
        cueId,
        ...favoriteSnapshotOf(cue),
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
      .where(and(eq(favorites.userId, 1), eq(favorites.cueId, cueId)))
      .all()[0];
    return NextResponse.json({ id: again?.id, duplicate: true });
  }
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}
