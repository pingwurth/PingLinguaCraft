/**
 * 复习队列 API（需求 18）
 * GET /api/review/queue?limit=20&statsOnly=1
 *   - 到期卡优先，新词补位（含词形/原句），附干扰词池与统计
 *   - statsOnly=1 时只返回统计（演练场入口仅展示三个数字，跳过建队/干扰池）
 * 词形去重：同一 lemma 收录多本词本时只出一题（保留最小 id 行，SQL 反连接，
 * 不再把全表拉进 JS 过滤）。
 */

import { NextResponse } from 'next/server';
import { and, asc, desc, eq, lte, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { getDb } from '@/lib/db';
import { cues, srsCards, words } from '@/lib/db/schema';

export const runtime = 'nodejs';

/** 队列项公共形态（isNew 驱动前端「新词/第N次复习」徽标；只保留前端实际渲染的字段） */
interface QueueItem {
  wordId: number;
  lemma: string;
  displayForm: string;
  aiNoteMd: string | null;
  reps: number;
  isNew: boolean;
  cueText: string | null;
}

/** 复习统计（词藏/演练场入口展示的三个数字） */
interface QueueStats {
  totalWords: number;
  dueCount: number;
  newCount: number;
}

/**
 * 解析 limit 查询参数：空串/非数字（如 abc → NaN）回落默认 20，钳制 1~50 取整。
 * 注意 Number('') === 0，空串必须显式拦截（否则会被钳成 1 而非默认值）
 * @param raw 原始查询串（可空）
 */
function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return 20;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : 20;
}

/**
 * GET —— 复习队列：到期卡（dueMs<=now）+ 无卡新词；附原句（挖空/听音题型素材）、
 * 干扰词池与统计
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const db = getDb();
  const now = Date.now();

  // 统计：words LEFT JOIN srs_cards（uq_srs_item 保证一对一），单条聚合完成三数。
  // 注意口径：三数为「去重前」计数（每张卡/每个无卡词条各计一次）——同 lemma
  // 多本收录时，stats 与下方 queue 的实际条数会有差额，属预期
  const statsRow = db
    .select({
      totalWords: sql<number>`count(*)`,
      totalCards: sql<number>`count(${srsCards.id})`,
      dueCount: sql<number>`count(${srsCards.id}) filter (where ${srsCards.dueMs} <= ${now})`,
    })
    .from(words)
    .leftJoin(srsCards, and(eq(srsCards.itemType, 'word'), eq(srsCards.itemId, words.id)))
    .where(eq(words.userId, 1))
    .all()[0]!;
  const stats: QueueStats = {
    totalWords: statsRow.totalWords,
    dueCount: statsRow.dueCount,
    newCount: statsRow.totalWords - statsRow.totalCards,
  };

  // 演练场入口等只要统计：短路返回（不建队、不取干扰池）
  if (params.get('statsOnly') === '1') {
    return NextResponse.json({ stats });
  }

  const limit = parseLimit(params.get('limit'));

  // 同 lemma 去重（反连接）：一词收多本词本只出一题。
  // - 到期支：让位规则 = 存在「同 lemma 已建卡且到期更早（同日则 id 更小）」
  //   的兄弟行时排除本行——同 lemma 的到期卡由最早到期者代表，真正到期的
  //   复习不会被「先收录但未到期」的兄弟遮蔽
  // - 新词支：两道反连接——① 同 lemma 任何行已建卡则整个 lemma 不当新词
  //   （已有卡在排程，不重学）；② 同 lemma 的多条无卡行只保留最小 id
  //   （多条未建卡副本不出重复题）
  const w2 = alias(words, 'w2');
  const sc2 = alias(srsCards, 'sc2');
  const cardedJoin = and(eq(sc2.itemType, 'word'), eq(sc2.itemId, w2.id));
  const dueDedupe = notExists(
    db
      .select({ one: sql`1` })
      .from(w2)
      .innerJoin(sc2, cardedJoin)
      .where(
        and(
          eq(w2.userId, words.userId),
          eq(w2.lemma, words.lemma),
          sql`(${sc2.dueMs} < ${srsCards.dueMs}) or (${sc2.dueMs} = ${srsCards.dueMs} and ${w2.id} < ${words.id})`
        )
      )
  );
  const lemmaNoCardAnywhere = notExists(
    db
      .select({ one: sql`1` })
      .from(w2)
      .innerJoin(sc2, cardedJoin)
      .where(and(eq(w2.userId, words.userId), eq(w2.lemma, words.lemma)))
  );
  const freshDedupe = notExists(
    db
      .select({ one: sql`1` })
      .from(w2)
      .where(and(eq(w2.userId, words.userId), eq(w2.lemma, words.lemma), sql`${w2.id} < ${words.id}`))
  );

  // 到期卡（连词取词与原句），按到期先后
  const due: QueueItem[] = db
    .select({
      wordId: words.id,
      lemma: words.lemma,
      displayForm: words.displayForm,
      aiNoteMd: words.aiNoteMd,
      reps: srsCards.reps,
      cueText: cues.textEn,
    })
    .from(srsCards)
    .innerJoin(words, eq(srsCards.itemId, words.id))
    .leftJoin(cues, eq(words.originCueId, cues.id))
    .where(and(eq(srsCards.itemType, 'word'), lte(srsCards.dueMs, new Date(now)), dueDedupe))
    .orderBy(asc(srsCards.dueMs))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, isNew: false }));

  // 新词补位（无卡词条，最新收录优先）
  const remaining = limit - due.length;
  const fresh: QueueItem[] =
    remaining > 0
      ? db
          .select({
            wordId: words.id,
            lemma: words.lemma,
            displayForm: words.displayForm,
            aiNoteMd: words.aiNoteMd,
            cueText: cues.textEn,
          })
          .from(words)
          .leftJoin(cues, eq(words.originCueId, cues.id))
          .where(and(eq(words.userId, 1), lemmaNoCardAnywhere, freshDedupe))
          .orderBy(desc(words.createdAt))
          .limit(remaining)
          .all()
          .map((r) => ({ ...r, reps: 0, isNew: true }))
      : [];

  // 干扰词池（选择题选项用；DISTINCT 按 lemma 去重，同词多本不重复出现；
  // 按 lemma 排序保证 LIMIT 截断的子集确定，不随查询计划漂移）
  const pool = db
    .selectDistinct({ lemma: words.lemma })
    .from(words)
    .where(eq(words.userId, 1))
    .orderBy(asc(words.lemma))
    .limit(200)
    .all()
    .map((x) => x.lemma);

  return NextResponse.json({ queue: [...due, ...fresh], pool, stats });
}
