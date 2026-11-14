/**
 * 单生词本 API：GET 词列表 / PATCH 更新 / DELETE 删除
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { wordBooks, words } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/word-books/[id]?q= —— 词列表（q 可选模糊过滤）
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? '';
  const db = getDb();
  const rows = db
    .select()
    .from(words)
    .where(eq(words.wordBookId, Number(id)))
    .all()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .filter((w) => !q || w.lemma.includes(q) || w.displayForm.toLowerCase().includes(q));
  return NextResponse.json({ words: rows });
}

/**
 * PATCH —— 更新生词本名/描述
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { name?: string; description?: string };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description;
  const db = getDb();
  db.update(wordBooks)
    .set(patch)
    .where(and(eq(wordBooks.id, Number(id)), eq(wordBooks.userId, 1)))
    .run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE —— 删除生词本（级联清词；wordId 引用的 origin_cue 为 set null 不受影响）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  db.delete(wordBooks)
    .where(and(eq(wordBooks.id, Number(id)), eq(wordBooks.userId, 1)))
    .run();
  return NextResponse.json({ ok: true });
}
