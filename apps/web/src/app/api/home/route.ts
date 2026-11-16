/**
 * 首页聚合 API：GET /api/home
 *
 * 一次请求供全首页（设计稿 _12 移动 / _10 桌面）：
 * - stats：卷数/材料数/总时长/已研句段/生词数（_10 统计卡网格）
 * - resume：最近停留的学习进度（_12 续研书签卡）
 * - recent：最近活跃材料 5 条（_10 流转动向）
 * - collections：集卷列表 + 每卷研读进度/最近研习时间（进度条与轻筛选）
 *
 * 单用户约定：userId=1（全库预留列一致）。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, cues, learningProgress, materials, words } from '@/lib/db/schema';
import type {
  HomeCollection,
  HomeData,
  HomeRecentMaterial,
  HomeResumePoint,
} from '@/features/home/types';

export const runtime = 'nodejs';

/**
 * 位图 popcount：数 listened_mask（逐句听过位图，bit i = 第 i 句听过）的置位数
 * @param buf 位图 BLOB（better-sqlite3 返回 Buffer；空为 null）
 */
function popcount(buf: Buffer | null): number {
  if (!buf) return 0;
  let n = 0;
  for (const byte of buf) {
    // Brian Kernighan 算法：每次清最低置位位
    let x = byte;
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

/**
 * 听句数 → 进度百分比（heard/total 四舍五入，上界 100；总句数为 0 时恒 0）
 * @param heard 已听句数（maxCueIndex+1 口径）
 * @param total 总句数
 */
function progressPct(heard: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((heard / total) * 100));
}

/**
 * GET —— 首页聚合数据
 */
export async function GET() {
  const db = getDb();

  /* 集卷列表 + 每卷聚合：材料数/时长/句数（未删材料）与研读进度（听句数聚合） */
  const collectionRows = db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      cover: collections.cover,
      cefrLevel: collections.cefrLevel,
      materialCount: sql<number>`count(${materials.id})`,
      totalDurationMs: sql<number>`coalesce(sum(${materials.mediaDurationMs}), 0)`,
      sentenceCount: sql<number>`coalesce(sum(${materials.sentenceCount}), 0)`,
      heardCount: sql<number>`coalesce(sum(${learningProgress.maxCueIndex} + 1), 0)`,
      lastStudiedAt: sql<number | null>`max(${learningProgress.updatedAt})`,
    })
    .from(collections)
    .leftJoin(
      materials,
      and(eq(materials.collectionId, collections.id), isNull(materials.deletedAt))
    )
    .leftJoin(
      learningProgress,
      and(eq(learningProgress.materialId, materials.id), eq(learningProgress.userId, 1))
    )
    .where(eq(collections.userId, 1))
    .groupBy(collections.id)
    .orderBy(collections.sortOrder, collections.id)
    .all();

  const collectionList: HomeCollection[] = collectionRows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    cover: r.cover,
    cefrLevel: r.cefrLevel,
    materialCount: r.materialCount,
    totalDurationMs: r.totalDurationMs,
    sentenceCount: r.sentenceCount,
    progressPct: progressPct(r.heardCount, r.sentenceCount),
    lastStudiedAt: r.lastStudiedAt,
  }));

  /* 续研书签：最近一次有实质进度的学习（maxCueIndex>0；材料须就绪且未删除） */
  const resumeRow = db
    .select({
      materialId: materials.id,
      materialTitle: materials.title,
      collectionId: collections.id,
      collectionName: collections.name,
      maxCueIndex: learningProgress.maxCueIndex,
      sentenceCount: materials.sentenceCount,
      updatedAt: learningProgress.updatedAt,
    })
    .from(learningProgress)
    .innerJoin(
      materials,
      and(
        eq(materials.id, learningProgress.materialId),
        isNull(materials.deletedAt),
        eq(materials.subtitleStatus, 'ready')
      )
    )
    .innerJoin(collections, eq(collections.id, materials.collectionId))
    .where(and(eq(learningProgress.userId, 1), gt(learningProgress.maxCueIndex, 0)))
    .orderBy(desc(learningProgress.updatedAt))
    .limit(1)
    .all()[0];

  let resume: HomeResumePoint | null = null;
  if (resumeRow) {
    // 总句数：sentence_count 就绪时已统计；缺失（老数据）则现数 cues 兜底
    let cueCount = resumeRow.sentenceCount;
    if (cueCount == null) {
      cueCount = db
        .select({ n: sql<number>`count(*)` })
        .from(cues)
        .where(eq(cues.materialId, resumeRow.materialId))
        .all()[0]!.n;
    }
    // 停留句引文：书签上展示「当前句」原文，缺失（句被重排等）静默降级为无引文
    const cue = db
      .select({ textEn: cues.textEn })
      .from(cues)
      .where(and(eq(cues.materialId, resumeRow.materialId), eq(cues.index, resumeRow.maxCueIndex)))
      .all()[0];
    resume = {
      materialId: resumeRow.materialId,
      materialTitle: resumeRow.materialTitle,
      collectionId: resumeRow.collectionId,
      collectionName: resumeRow.collectionName,
      maxCueIndex: resumeRow.maxCueIndex,
      cueCount,
      progressPct: progressPct(resumeRow.maxCueIndex + 1, cueCount),
      lastCueText: cue?.textEn ?? '',
      updatedAt: resumeRow.updatedAt.getTime(),
    };
  }

  /* 流转动向：最近活跃（学习时间与材料更新时间取大）的前 5 条未删材料 */
  const recentRows = db
    .select({
      materialId: materials.id,
      title: materials.title,
      sourceType: materials.sourceType,
      mediaDurationMs: materials.mediaDurationMs,
      sentenceCount: materials.sentenceCount,
      uniqueWordCount: materials.uniqueWordCount,
      subtitleStatus: materials.subtitleStatus,
      collectionId: collections.id,
      collectionName: collections.name,
      maxCueIndex: learningProgress.maxCueIndex,
      activityAt: sql<number>`max(coalesce(${learningProgress.updatedAt}, 0), ${materials.updatedAt})`,
    })
    .from(materials)
    .innerJoin(collections, eq(collections.id, materials.collectionId))
    .leftJoin(
      learningProgress,
      and(eq(learningProgress.materialId, materials.id), eq(learningProgress.userId, 1))
    )
    .where(and(eq(materials.userId, 1), isNull(materials.deletedAt)))
    .orderBy(sql`max(coalesce(${learningProgress.updatedAt}, 0), ${materials.updatedAt}) desc`)
    .limit(5)
    .all();

  const recent: HomeRecentMaterial[] = recentRows.map((r) => ({
    materialId: r.materialId,
    title: r.title,
    sourceType: r.sourceType,
    mediaDurationMs: r.mediaDurationMs,
    sentenceCount: r.sentenceCount,
    uniqueWordCount: r.uniqueWordCount,
    subtitleStatus: r.subtitleStatus as HomeRecentMaterial['subtitleStatus'],
    collectionId: r.collectionId,
    collectionName: r.collectionName,
    maxCueIndex: r.maxCueIndex,
    progressPct: progressPct((r.maxCueIndex ?? -1) + 1, r.sentenceCount ?? 0),
    activityAt: r.activityAt,
  }));

  /* 统计卡：卷数/材料数/总时长取自集卷聚合；已研句段=位图置位数求和；生词=words 总数 */
  const masks = db
    .select({ mask: learningProgress.listenedMask })
    .from(learningProgress)
    .all();
  // blob() 列经 drizzle select 推断为 unknown，此处按 schema 实际类型（Buffer|null）收窄
  const studiedSentenceCount = masks.reduce(
    (a, r) => a + popcount(r.mask as Buffer | null),
    0
  );
  const wordCount = db
    .select({ n: sql<number>`count(*)` })
    .from(words)
    .all()[0]!.n;

  const data: HomeData = {
    stats: {
      collectionCount: collectionRows.length,
      materialCount: collectionList.reduce((a, c) => a + c.materialCount, 0),
      totalDurationMs: collectionList.reduce((a, c) => a + c.totalDurationMs, 0),
      studiedSentenceCount,
      wordCount,
    },
    resume,
    recent,
    collections: collectionList,
  };
  return NextResponse.json(data);
}
