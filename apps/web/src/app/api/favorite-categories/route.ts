/**
 * 收藏分类 API：GET / POST / DELETE（需求 13：收藏可选择分类，支持自定义分类）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { favoriteCategories, favorites } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET —— 分类列表（每类含收藏数）
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select()
    .from(favoriteCategories)
    .where(eq(favoriteCategories.userId, 1))
    .orderBy(favoriteCategories.sortOrder, favoriteCategories.id)
    .all();
  return NextResponse.json({ categories: rows });
}

/**
 * POST —— 创建分类；Body: { name }
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { name?: string };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: '分类名不能为空' }, { status: 400 });
  const db = getDb();
  try {
    const now = new Date();
    const r = db
      .insert(favoriteCategories)
      .values({ userId: 1, name, createdAt: now, updatedAt: now })
      .returning({ id: favoriteCategories.id })
      .all();
    return NextResponse.json({ id: r[0]!.id }, { status: 201 });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return NextResponse.json({ error: '已存在同名分类' }, { status: 409 });
    }
    throw err;
  }
}

/**
 * DELETE —— 删除分类（收藏的 categoryId 置空，不删收藏）
 */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });
  const db = getDb();
  db.update(favorites)
    .set({ categoryId: null, updatedAt: new Date() })
    .where(eq(favorites.categoryId, Number(id)))
    .run();
  db.delete(favoriteCategories).where(eq(favoriteCategories.id, Number(id))).run();
  return NextResponse.json({ ok: true });
}
