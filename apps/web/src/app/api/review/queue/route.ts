/**
 * 复习队列 API（需求 18）
 * GET /api/review/queue?limit=20 —— 到期卡优先，新词补位（含词形/原句/统计）
 */

import { NextResponse } from 'next/server';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues, srsCards, words } from '@/lib/db/schema';

export const runtime = 'nodejs';

/** 队列项公共形态（isNew 驱动前端「新词/第N次复习」徽标） */
interface QueueItem {
  wordId: number;
  lemma: string;
  displayForm: string;
  aiNoteMd: string | null;
  reps: number;
  stability: number;
  dueMs: number;
  isNew: boolean;
  cueText: string | null;
  cueStartMs: number | null;
  cueEndMs: number | null;
}

/**
 * GET —— 复习队列：到期卡（dueMs<=now）+ 无卡新词；附原句（挖空/听音题型素材）与统计
 */
export async function GET(request: Request) {
  const limit = Math.min(50, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? '20')));
  const db = getDb();
  const now = Date.now();

  // 到期卡（连词取词与原句）
  const due: QueueItem[] = db
    .select({
      wordId: words.id,
      lemma: words.lemma,
      displayForm: words.displayForm,
      aiNoteMd: words.aiNoteMd,
      reps: srsCards.reps,
      stability: srsCards.stability,
      dueMs: sql<number>`0`,
      cueText: cues.textEn,
      cueStartMs: cues.startMs,
      cueEndMs: cues.endMs,
    })
    .from(srsCards)
    .innerJoin(words, eq(srsCards.itemId, words.id))
    .leftJoin(cues, eq(words.originCueId, cues.id))
    .where(and(eq(srsCards.itemType, 'word'), lte(srsCards.dueMs, new Date(now))))
    .orderBy(asc(srsCards.dueMs))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, dueMs: 0, isNew: false }));

  // 新词补位（无卡词条，最新收录优先）
  const fresh: QueueItem[] = [];
  const remaining = limit - due.length;
  if (remaining > 0) {
    const cardedSet = new Set(
      db.select({ itemId: srsCards.itemId }).from(srsCards).where(eq(srsCards.itemType, 'word')).all().map((c) => c.itemId)
    );
    const rows = db
      .select({
        wordId: words.id,
        lemma: words.lemma,
        displayForm: words.displayForm,
        aiNoteMd: words.aiNoteMd,
        cueText: cues.textEn,
        cueStartMs: cues.startMs,
        cueEndMs: cues.endMs,
      })
      .from(words)
      .leftJoin(cues, eq(words.originCueId, cues.id))
      .where(eq(words.userId, 1))
      .orderBy(sql`${words.createdAt} DESC`)
      .all()
      .filter((w) => !cardedSet.has(w.wordId))
      .slice(0, remaining);
    fresh.push(...rows.map((w) => ({ ...w, reps: 0, stability: 0, dueMs: 0, isNew: true })));
  }

  // 干扰词池（选择题选项用）
  const pool = db
    .select({ lemma: words.lemma })
    .from(words)
    .where(eq(words.userId, 1))
    .limit(200)
    .all()
    .map((x) => x.lemma);

  // 统计
  const totalWords = db.select({ n: sql<number>`count(*)` }).from(words).where(eq(words.userId, 1)).all()[0]!.n;
  const totalCards = db.select({ n: sql<number>`count(*)` }).from(srsCards).all()[0]!.n;
  const dueCount = db
    .select({ n: sql<number>`count(*)` })
    .from(srsCards)
    .where(and(eq(srsCards.itemType, 'word'), lte(srsCards.dueMs, new Date(now))))
    .all()[0]!.n;

  return NextResponse.json({
    queue: [...due, ...fresh],
    pool,
    stats: { totalWords, totalCards, dueCount, newCount: totalWords - totalCards },
  });
}
