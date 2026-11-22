/**
 * 语流队列 API：GET /api/stream/queue —— 全部就绪材料的连续研习流（/stream 页）
 *
 * 队列规则：subtitleStatus=ready 且未软删的材料，按「最近研习优先」排序——
 * 有学习进度的按 learning_progress.updated_at 倒序（接着上次研习的听），
 * 无进度的按导入时间倒序垫后（新导入优先尝试）；单次全量返回
 * （单用户自托管，材料量为个人库规模，无需分页）。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, learningProgress, materials } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET —— 语流队列（ready 材料 + 所属集名 + 学习进度摘要）
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      id: materials.id,
      title: materials.title,
      collectionId: materials.collectionId,
      collectionName: collections.name,
      mediaDurationMs: materials.mediaDurationMs,
      sentenceCount: materials.sentenceCount,
      lastPositionMs: learningProgress.lastPositionMs,
      listenedThrough: learningProgress.listenedThrough,
      // 排序键：研习过的时间戳（无进度视为 0，排到队尾组）
      lastStudiedAt: sql<number>`coalesce(${learningProgress.updatedAt}, 0)`,
    })
    .from(materials)
    .innerJoin(collections, eq(materials.collectionId, collections.id))
    .leftJoin(
      learningProgress,
      and(eq(learningProgress.materialId, materials.id), eq(learningProgress.userId, 1))
    )
    .where(and(eq(materials.subtitleStatus, 'ready'), isNull(materials.deletedAt)))
    .orderBy(desc(sql`coalesce(${learningProgress.updatedAt}, 0)`), desc(materials.createdAt))
    .all();

  const queue = rows.map((r) => ({
    id: r.id,
    title: r.title,
    collectionId: r.collectionId,
    collectionName: r.collectionName,
    mediaDurationMs: r.mediaDurationMs,
    sentenceCount: r.sentenceCount,
    // lastStudiedAt=0 即从未研习（leftJoin 无匹配行）
    progress:
      r.lastStudiedAt > 0 ? { lastPositionMs: r.lastPositionMs, listenedThrough: r.listenedThrough } : null,
  }));
  return NextResponse.json({ queue });
}
