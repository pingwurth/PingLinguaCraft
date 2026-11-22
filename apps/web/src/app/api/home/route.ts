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
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { countListenedBits } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { collections, cues, learningProgress, materials, words } from '@/lib/db/schema';
import { cueCountsFor, estimateHeardNoMask, progressPct } from '@/lib/server/progress';
import type {
  HomeCollection,
  HomeData,
  HomeRecentMaterial,
  HomeResumePoint,
} from '@/features/home/types';

export const runtime = 'nodejs';

/** 最近活跃时间表达式：学习时间与材料更新时间取大（select 与 orderBy 共用一份，防两处口径漂移） */
const activityAtExpr = sql<number>`max(coalesce(${learningProgress.updatedAt}, 0), ${materials.updatedAt})`;

/** 续研书签候选窗口宽度：甄别（弃「只开过播放页」的存量行）在 JS 侧做
 *  （SQL 表达不了「位图全空」），窗口外的合格行会静默降级为无书签——单
 *  用户最近几条进度行全为待弃行的情况极罕见，取此取舍 */
const RESUME_CANDIDATE_LIMIT = 5;

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
   * 不算已研（否则统计永久虚高、heard 可能超过 sentenceCount）。
   * 句数缺失（老数据）现数 cues 兜底，保证与集卷分母 sum(sentence_count) 同一
   * 材料集合——分子计 NULL 句数材料而分母跳过会让混装卷 heard 超过 sentenceCount */
  const heardRows = db
    .select({
      materialId: materials.id,
      collectionId: materials.collectionId,
      mask: learningProgress.listenedMask,
      maxCueIndex: learningProgress.maxCueIndex,
      sentenceCount: materials.sentenceCount,
    })
    .from(learningProgress)
    .innerJoin(
      materials,
      and(eq(materials.id, learningProgress.materialId), isNull(materials.deletedAt))
    )
    .where(eq(learningProgress.userId, 1))
    .all();
  const cueCountByMaterial = cueCountsFor(
    db,
    heardRows.filter((r) => r.sentenceCount == null).map((r) => r.materialId),
  );
  /* 分母按卷聚合：全部未删材料（含从未打开的）——此前只在进度行循环里累计，
   * 「10 篇只听过 1 篇」的卷会算出 100%；NULL sentence_count 同样走 cues 兜底
   * （SQL sum(sentence_count) 会跳过 NULL 行，混装卷会出现 heard > 分母、被
   * progressPct 的上界静默夹成 100% 的假完卷） */
  const denomRows = db
    .select({
      materialId: materials.id,
      collectionId: materials.collectionId,
      sentenceCount: materials.sentenceCount,
    })
    .from(materials)
    .where(and(eq(materials.userId, 1), isNull(materials.deletedAt)))
    .all();
  const denomCueCounts = cueCountsFor(
    db,
    denomRows.filter((r) => r.sentenceCount == null).map((r) => r.materialId),
  );
  const sentenceTotalByCollection = new Map<number, number>();
  for (const r of denomRows) {
    const total = r.sentenceCount ?? denomCueCounts.get(r.materialId) ?? 0;
    sentenceTotalByCollection.set(r.collectionId, (sentenceTotalByCollection.get(r.collectionId) ?? 0) + total);
  }
  /* 位图为空的存量行按 maxCueIndex+1 估算（与 resume 甄别兼容：仅 maxCueIndex>0
     * 的无位图行与之同口径；maxCueIndex=0 的无位图行在 resume 按弃行处理，
     * 但仍计入卷进度/近况——两处判定不可互相套用） */
  const heardByCollection = new Map<number, number>();
  for (const r of heardRows) {
    // blob() 列经 drizzle select 推断为 unknown，按 schema 实际类型（Buffer|null）收窄
    const mask = r.mask as Buffer | null;
    const total = r.sentenceCount ?? cueCountByMaterial.get(r.materialId) ?? 0;
    const heard = mask ? countListenedBits(mask, total) : estimateHeardNoMask(r.maxCueIndex, total);
    heardByCollection.set(r.collectionId, (heardByCollection.get(r.collectionId) ?? 0) + heard);
  }

  const collectionList: HomeCollection[] = collectionRows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    cover: r.cover,
    cefrLevel: r.cefrLevel,
    materialCount: r.materialCount,
    totalDurationMs: r.totalDurationMs,
    // 展示句数与百分比分母同源（cues 兜底口径），卷卡「X 句」与「已研 Y%」不打架
    sentenceCount: sentenceTotalByCollection.get(r.id) ?? r.sentenceCount,
    progressPct: progressPct(heardByCollection.get(r.id) ?? 0, sentenceTotalByCollection.get(r.id) ?? 0),
    lastStudiedAt: r.lastStudiedAt,
  }));

  /* 续研书签：最近一次有实质进度的学习（观测到任一句即算——含只听过首句的
   * 卷，此前 >0 过滤会让「最近研习：刚刚」的卷同卡挂着「尚未开卷」的自相
   * 矛盾；maxCueIndex=-1 表示未观测到句位，不上书签；材料须就绪且未删除） */
  const resumeRows = db
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
    .where(and(eq(learningProgress.userId, 1), gte(learningProgress.maxCueIndex, 0)))
    .orderBy(desc(learningProgress.updatedAt))
    .limit(RESUME_CANDIDATE_LIMIT)
    .all();

  /* 候选行句数兜底直接复用上方 cueCountByMaterial：heardRows（全部 userId=1
   * 进度行 × 未删材料）是本候选集的超集，同材料 NULL sentence_count 的计数
   * 必然一致——再发一次批量查询是同一口径的第二份源 */

  let resume: HomeResumePoint | null = null;
  for (const resumeRow of resumeRows) {
    // 总句数：sentence_count 就绪时已统计；缺失（老数据）则现数 cues 兜底
    const cueCount = resumeRow.sentenceCount ?? cueCountByMaterial.get(resumeRow.materialId) ?? 0;
    /* 存量行甄别：maxCueIndex=0 且位图全空（或无位图）= 旧版上报器把 -1 钳 0
     * 写成的「只开过播放页」行（新版已改写 -1），不上书签——防凭空冒出
     * 「第 1 句」；只听过首句的行位图 bit0 已置、无位图存量行按 maxCueIndex>0
     * 判定（mask NULL 正是旧版未带位图的形态），正常入选 */
    const mask = resumeRow.listenedMask as Buffer | null;
    const heardAny = resumeRow.maxCueIndex > 0 || (mask != null && countListenedBits(mask, cueCount) > 0);
    if (!heardAny) continue;
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
      // 位图口径：实际听过句数（跳句不计，按句数截断防越界旧位），与集卷/统计卡
      // 一致；maxCueIndex 仅用于「第 N 句」定位展示。位图为空的存量行（位图机制
      // 之前写入）按 maxCueIndex+1 估算，避免「第 N 句」旁挂着刺眼的 0%
      progressPct: progressPct(
        mask ? countListenedBits(mask, cueCount) : estimateHeardNoMask(resumeRow.maxCueIndex, cueCount),
        cueCount
      ),
      lastCueText: cue?.textEn ?? '',
      updatedAt: resumeRow.updatedAt.getTime(),
    };
    break;
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

  const recentCueCounts = cueCountsFor(
    db,
    recentRows.filter((r) => r.sentenceCount == null).map((r) => r.materialId),
  );
  const recent: HomeRecentMaterial[] = recentRows.map((r) => {
    const mask = r.listenedMask as Buffer | null;
    /* 分母句数缺失（老数据）现数 cues 兜底；无位图行按 maxCueIndex+1 估算
       （与集卷聚合/集内列表同口径；resume 书签额外弃 maxCueIndex=0 的无位图
       存量行，见其甄别注释——估算口径本身一致） */
    const total = r.sentenceCount ?? recentCueCounts.get(r.materialId) ?? 0;
    const heard = mask ? countListenedBits(mask, total) : estimateHeardNoMask(r.maxCueIndex, total);
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
      progressPct: progressPct(heard, total),
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
