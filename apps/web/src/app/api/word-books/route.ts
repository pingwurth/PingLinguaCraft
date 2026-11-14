/**
 * 生词本 API：GET 列表（含词数）/ POST 创建（需求 14：自定义多个生词本）
 */

import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { wordBooks, words } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/word-books —— 生词本列表（每本含词数与待复习数）
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      id: wordBooks.id,
      name: wordBooks.name,
      description: wordBooks.description,
      createdAt: wordBooks.createdAt,
      wordCount: sql<number>`(
        SELECT count(*) FROM ${words} WHERE ${words.wordBookId} = ${wordBooks.id}
      )`,
    })
    .from(wordBooks)
    .where(eq(wordBooks.userId, 1))
    .orderBy(wordBooks.sortOrder, wordBooks.id)
    .all();
  return NextResponse.json({ books: rows });
}

/**
 * POST /api/word-books —— 创建生词本；Body: { name, description? }
 * 首本自动创建为默认（词藏页展示「我的生词本」）
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { name?: string; description?: string };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: '生词本名不能为空' }, { status: 400 });
  const db = getDb();
  const now = new Date();
  try {
    const r = db
      .insert(wordBooks)
      .values({ userId: 1, name, description: body.description?.trim() || null, createdAt: now, updatedAt: now })
      .returning({ id: wordBooks.id })
      .all();
    return NextResponse.json({ id: r[0]!.id }, { status: 201 });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return NextResponse.json({ error: '已存在同名生词本' }, { status: 409 });
    }
    throw err;
  }
}
