/**
 * 复习作答 API（需求 18）：POST /api/review/answer
 * Body: { wordId, rating: 'again'|'hard'|'good'|'easy' }
 * FSRS-6 调度（core）→ srs_cards upsert + srs_review_logs + words 状态回写
 */

import { NextResponse } from 'next/server';
import { fsrsSchedule, toFSRSRating, wordStatus, type SRating } from '@pinglc/core';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { srsCards, srsReviewLogs, words } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * POST —— 提交一次复习评分
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { wordId?: number; rating?: SRating };
  const rating = body.rating;
  const RATINGS: SRating[] = ['again', 'hard', 'good', 'easy'];
  if (!body.wordId || !rating || !RATINGS.includes(rating)) {
    return NextResponse.json({ error: '需要 wordId 与合法 rating' }, { status: 400 });
  }
  const db = getDb();
  // 热写路径只取 id 判存在（words 表含 aiNoteMd/etymologyJson 等大文本列，
  // 逐次评分反序列化整行纯属浪费）
  const word = db.select({ id: words.id }).from(words).where(eq(words.id, body.wordId)).all()[0];
  if (!word) return NextResponse.json({ error: '单词不存在' }, { status: 404 });

  // 现有卡（无则新卡）
  const card = db
    .select()
    .from(srsCards)
    .where(and(eq(srsCards.itemType, 'word'), eq(srsCards.itemId, word.id)))
    .all()[0];
  const now = new Date();
  const result = fsrsSchedule(
    card
      ? {
          stability: card.stability,
          difficulty: card.difficulty,
          lastReviewMs: card.lastReviewMs ? card.lastReviewMs.getTime() : now.getTime(),
          reps: card.reps,
          lapses: card.lapses,
        }
      : null,
    toFSRSRating(rating),
    now.getTime()
  );

  // 卡片推进 + 复习日志 + 词状态回写：同一事务（中途失败不产生「有推进无日志」的撕裂）；
  // upsert 规避并发/重复提交撞唯一约束 uq_srs_item
  const cardValues = {
    stability: result.state.stability,
    difficulty: result.state.difficulty,
    dueMs: new Date(result.dueMs),
    lastReviewMs: now,
    reps: result.state.reps,
    lapses: result.state.lapses,
  };
  db.transaction((tx) => {
    const upserted = tx
      .insert(srsCards)
      .values({ userId: 1, itemType: 'word', itemId: word.id, ...cardValues })
      .onConflictDoUpdate({
        target: [srsCards.itemType, srsCards.itemId],
        set: cardValues,
      })
      .returning({ id: srsCards.id })
      .all();
    const cardId = upserted[0]!.id;
    tx.insert(srsReviewLogs)
      .values({ cardId, rating: toFSRSRating(rating), scheduledDays: result.scheduledDays, reviewedMs: now })
      .run();
    tx.update(words)
      .set({ status: wordStatus(result.state.reps, rating), lastReviewedAt: now, updatedAt: now })
      .where(eq(words.id, word.id))
      .run();
  });

  return NextResponse.json({
    scheduledDays: result.scheduledDays,
    dueMs: result.dueMs,
    stability: result.state.stability,
  });
}
