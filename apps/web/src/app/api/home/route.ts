/**
 * 首页聚合 API：GET /api/home
 *
 * 一次请求供全首页（设计稿 _12 移动 / _10 桌面）：
 * - stats：卷数/材料数/总时长/已研句段/生词数（_10 统计卡网格）
 * - resume：最近停留的学习进度（_12 续研书签卡）
 * - recent：最近活跃材料 5 条（_10 案头近况）
 * - collections：集卷列表 + 每卷研读进度/最近研习时间（进度条与轻筛选）
 *
 * 单用户约定：userId=1（全库预留列一致）。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { countListenedBits } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { collections, cues, learningProgress, materials, words } from '@/lib/db/schema';
import { progressPct } from '@/lib/server/progress';
import type {
  HomeCollection,
  HomeData,
  HomeRecentMaterial,
  HomeResumePoint,
} from '@/features/home/types';

export const runtime = 'nodejs';

/** 最近活跃时间表达式：学习时间与材料更新时间取大（select 与 orderBy 共用一份，防两处口径漂移） */
const activityAtExpr = sql<number>`max(coalesce(${learningProgress.updatedAt}, 0), ${materials.updatedAt})`;

/**
 * GET —— 首页聚合数据
 */
export async function GET() {
  const db = getDb();

  /* 集卷列表 + 每卷聚合：材料数/时长/句数（未删材料）；研读进度走位图（见下） */
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

  /* 位图听句数（按卷聚合）：逐进度行按材料句数截断的 popcount 在 JS 侧求和——
   * 口径 = 实际听过句数（跳句不计，仅计 userId=1 的未软删材料）；统计卡「已研句段」
   * 也取此聚合的总和（单一来源——旧实现另起全表位图查询且缺 deletedAt/userId 过滤，
   * 软删材料后统计卡虚高、与集卷卡/书签/近况漂移）；单用户进度行量级小，开销可忽略。
   * 截断到现句数与进度 PUT 同口径：重跑 STT 句数变少时位图合并保留的旧高位
   * 不算已研（否则统计永久虚高、heard 可能超过 sentenceCount） */
  const heardByCollection = new Map<number, number>();
  for (const r of db
    .select({
      collectionId: materials.collectionId,
      mask: learningProgress.listenedMask,
      sentenceCount: materials.sentenceCount,
    })
    .from(learningProgress)
    .innerJoin(
      materials,
      and(eq(materials.id, learningProgress.materialId), isNull(materials.deletedAt))
    )
    .where(eq(learningProgress.userId, 1))
    .all()) {
    // blob() 列经 drizzle select 推断为 unknown，按 schema 实际类型（Buffer|null）收窄
    const mask = r.mask as Buffer | null;
    if (!mask) continue;
    // 句数缺失（老数据）退回整位图口径：截断目的只是丢弃越界旧位，缺句数时无从判定
    const total = r.sentenceCount ?? mask.length * 8;
    heardByCollection.set(r.collectionId, (heardByCollection.get(r.collectionId) ?? 0) + countListenedBits(mask, total));
  }

  const collectionList: HomeCollection[] = collectionRows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    cover: r.cover,
    cefrLevel: r.cefrLevel,
    materialCount: r.materialCount,
    totalDurationMs: r.totalDurationMs,
    sentenceCount: r.sentenceCount,
    progressPct: progressPct(heardByCollection.get(r.id) ?? 0, r.sentenceCount),
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
      listenedMask: learningProgress.listenedMask,
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
      // 位图口径：实际听过句数（跳句不计，按句数截断防越界旧位），与集卷/统计卡一致；
      // maxCueIndex 仅用于「第 N 句」定位展示
      progressPct: progressPct(
        resumeRow.listenedMask ? countListenedBits(resumeRow.listenedMask as Buffer, cueCount) : 0,
        cueCount
      ),
      lastCueText: cue?.textEn ?? '',
      updatedAt: resumeRow.updatedAt.getTime(),
    };
  }

  /* 案头近况：最近活跃（学习时间与材料更新时间取大）的前 5 条未删材料 */
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
      listenedMask: learningProgress.listenedMask,
      activityAt: activityAtExpr,
    })
    .from(materials)
    .innerJoin(collections, eq(collections.id, materials.collectionId))
    .leftJoin(
      learningProgress,
      and(eq(learningProgress.materialId, materials.id), eq(learningProgress.userId, 1))
    )
    .where(and(eq(materials.userId, 1), isNull(materials.deletedAt)))
    .orderBy(desc(activityAtExpr))
    .limit(5)
    .all();

  const recent: HomeRecentMaterial[] = recentRows.map((r) => {
    const mask = r.listenedMask as Buffer | null;
    /* 分母句数缺失（老数据）时位图按整幅计（无从截断），百分比侧分母为 0 恒 0% */
    const maskTotal = r.sentenceCount ?? (mask ? mask.length * 8 : 0);
    return {
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
      // 位图口径：实际听过句数（跳句不计，按句数截断防越界旧位），与集卷/书签/统计卡一致
      progressPct: progressPct(mask ? countListenedBits(mask, maskTotal) : 0, r.sentenceCount ?? 0),
      activityAt: r.activityAt,
    };
  });

  /* 统计卡：卷数/材料数/总时长取自集卷聚合；已研句段=上方按卷位图聚合求和（同一查询
   * 同一口径，天然排除软删材料）；生词=words 总数（补 userId=1 过滤，全库预留列约定） */
  const studiedSentenceCount = [...heardByCollection.values()].reduce((a, n) => a + n, 0);
  const wordCount = db
    .select({ n: sql<number>`count(*)` })
    .from(words)
    .where(eq(words.userId, 1))
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
