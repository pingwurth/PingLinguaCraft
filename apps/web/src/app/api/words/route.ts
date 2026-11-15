/**
 * 生词 API：POST 添加（划词/点词收录，需求 14）
 */

import { NextResponse } from 'next/server';
import { normalizeWord } from '@pinglc/core';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { wordBooks, words } from '@/lib/db/schema';
import { readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST /api/words —— Body: { word, bookId?, cueId?, materialId? }
 * 归一化查重（同本重复收录幂等返回已有 id）
 */
export async function POST(request: Request) {
  const body = await readJsonBody<{
    word?: string;
    bookId?: number;
    cueId?: number;
    materialId?: number;
  }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const raw = body.word?.trim();
  if (!raw) return NextResponse.json({ error: '单词不能为空' }, { status: 400 });
  const lemma = normalizeWord(raw);
  if (!lemma) return NextResponse.json({ error: '非有效英文单词' }, { status: 400 });

  const db = getDb();
  // 未指定本：落入第一本；无本则自动建「默认生词本」
  let bookId: number | undefined = body.bookId;
  if (!bookId) {
    const first = db
      .select({ id: wordBooks.id })
      .from(wordBooks)
      .where(eq(wordBooks.userId, 1))
      .orderBy(wordBooks.sortOrder, wordBooks.id)
      .all()[0];
    if (first) {
      bookId = first.id;
    } else {
      const now = new Date();
      const r = db
        .insert(wordBooks)
        .values({ userId: 1, name: '默认生词本', createdAt: now, updatedAt: now })
        .returning({ id: wordBooks.id })
        .all();
      bookId = r[0]!.id;
    }
  }
  const finalBookId = bookId!;

  // 精确查重（lemma + book）
  const dup = db
    .select({ id: words.id })
    .from(words)
    .where(and(eq(words.wordBookId, finalBookId), eq(words.lemma, lemma)))
    .all()[0];
  if (dup) return NextResponse.json({ id: dup.id, duplicate: true });

  const now = new Date();
  const r = db
    .insert(words)
    .values({
      userId: 1,
      wordBookId: finalBookId,
      lemma,
      displayForm: raw,
      originCueId: body.cueId ?? null,
      originMaterialId: body.materialId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: words.id })
    .all();
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}
