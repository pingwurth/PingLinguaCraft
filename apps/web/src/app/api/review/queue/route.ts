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

  // 同 lemma 去重谓词（反连接）：一词收多本词本只出一题。统计与建队共用
  // 这同一套谓词（统计 = 同谓词的 count），口径永远一致——此前统计是手写
  // 分组 SQL 的镜像实现，改一侧漏一侧即「角标 12 题、队列发 9 题」。
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
          // 注意整组再包一层括号：and() 只给整条合取加括号，裸 or 片段会被
          // SQL 的 AND 优先级拆散（tie-break 失去 user_id/lemma 关联）
          sql`((${sc2.dueMs} < ${srsCards.dueMs}) or (${sc2.dueMs} = ${srsCards.dueMs} and ${w2.id} < ${words.id}))`
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

  // 统计（与队列完全同谓词的 count，杜绝「同词多本」虚增）：
  //   totalWords = 词条（lemma）总数
  //   dueCount   = 到期支谓词命中的行数（= 到期支会出的题数）
  //   newCount   = 新词支谓词命中的行数（= 新词支会出的题数上限）
  const totalWords =
    db
      .select({ n: sql<number>`count(distinct ${words.lemma})` })
      .from(words)
      .where(eq(words.userId, 1))
      .all()[0]!.n;
  const dueCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(srsCards)
      .innerJoin(words, eq(srsCards.itemId, words.id))
      .where(
        and(
          eq(srsCards.itemType, 'word'),
          eq(words.userId, 1),
          lte(srsCards.dueMs, new Date(now)),
          dueDedupe
        )
      )
      .all()[0]!.n;
  const newCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(words)
      .where(and(eq(words.userId, 1), lemmaNoCardAnywhere, freshDedupe))
      .all()[0]!.n;
  const stats: QueueStats = { totalWords, dueCount, newCount };

  // 演练场入口等只要统计：短路返回（不建队、不取干扰池）
  if (params.get('statsOnly') === '1') {
    return NextResponse.json({ stats });
  }

  const limit = parseLimit(params.get('limit'));

  // 到期卡（连词取词与原句），按到期先后（谓词见上方统计段的共用反连接；
  // 与统计同口径限定 user 1——预留的 user_id 一旦出现其他值不得混入建队）
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
    .where(
      and(
        eq(srsCards.itemType, 'word'),
        eq(words.userId, 1),
        lte(srsCards.dueMs, new Date(now)),
        dueDedupe
      )
    )
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

  // 干扰词池（选择题选项用；按 lemma 去重，同词多本不重复出现）。
  // 均匀取样而非 ORDER BY RANDOM()：后者每次请求都物化并洗牌全部词元
  // （成本随词库增长，而客户端每轮只快照一次）；DISTINCT 内部本就按
  // lemma 有序，ROW_NUMBER 复用该序做取样，随机相位保证每次取样的集合
  // 不同、覆盖整个字母区间（不像字母序截断那样集中在 a-c 让正确答案一眼
  // 可辨）；同轮次的确定性由前端 seededPick 保证。
  // - 词库 > 池容：步长取样（rn % step = phase）把候选压到 < 2×池容，
  //   候选超出池容时在 JS 端随机抽取——绝不用「ORDER BY lemma LIMIT 池容」
  //   截断（那会把尾部字母区间的词元永久排除在干扰池外）
  // - 词库 ≤ 池容：step=1 全量候选，同样 JS 随机抽取
  const POOL_SIZE = 200;
  // 复用上面已算好的 totalWords（同一条 count(distinct lemma) 谓词，重复查询
  // 既浪费又留两处口径漂移的口子）
  const step = Math.max(1, Math.floor(totalWords / POOL_SIZE));
  const phase = Math.floor(Math.random() * step);
  const candidates = db
    .all<{ lemma: string }>(sql`
      select lemma from (
        select lemma, row_number() over (order by lemma) as rn
        from (select distinct ${words.lemma} as lemma from ${words} where ${words.userId} = 1)
      ) where rn % ${step} = ${phase} order by lemma
    `)
    .map((x) => x.lemma);
  // Fisher–Yates 洗牌后取前 POOL_SIZE（候选至多 ~2×池容，全字母区间都有份）
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  const pool = candidates.slice(0, POOL_SIZE);

  return NextResponse.json({ queue: [...due, ...fresh], pool, stats });
}
