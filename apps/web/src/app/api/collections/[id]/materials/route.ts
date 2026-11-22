/**
 * 材料集内材料分页列表 API（需求 19：支持分页查询）
 * GET /api/collections/[id]/materials?page=1&pageSize=20&status=ready
 *
 * 每条材料附位图口径学习进度 progress（案头今研首页逐篇进度条消费）：
 * 与 /api/home 同一口径（实际听过句数/总句数，跳句不计），单源见 lib/server/progress。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { countListenedBits } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { cues, learningProgress, materials } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';
import { estimateHeardNoMask, progressPct } from '@/lib/server/progress';
import type { MaterialListItem, MaterialSourceType, SubtitleStatus } from '@pinglc/core';

export const runtime = 'nodejs';

/**
 * GET —— 分页材料列表（软删过滤；subtitle_status 过滤可选；附每条材料的研读进度）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20')));
  const status = url.searchParams.get('status');

  const db = getDb();
  const where = and(
    eq(materials.collectionId, pid),
    isNull(materials.deletedAt),
    status ? eq(materials.subtitleStatus, status) : undefined
  );

  const total = db.select({ n: sql<number>`count(*)` }).from(materials).where(where).all()[0]!.n;
  const rows = db
    .select({
      id: materials.id,
      title: materials.title,
      sourceType: materials.sourceType,
      mediaMime: materials.mediaMime,
      mediaDurationMs: materials.mediaDurationMs,
      subtitleStatus: materials.subtitleStatus,
      sentenceCount: materials.sentenceCount,
      uniqueWordCount: materials.uniqueWordCount,
      createdAt: materials.createdAt,
      /* 进度回填三件套：updatedAt 兼作「有无进度行」存在性判据（leftJoin 无匹配全空） */
      progressUpdatedAt: learningProgress.updatedAt,
      maxCueIndex: learningProgress.maxCueIndex,
      listenedThrough: learningProgress.listenedThrough,
      listenedMask: learningProgress.listenedMask,
    })
    .from(materials)
    .leftJoin(
      learningProgress,
      and(eq(learningProgress.materialId, materials.id), eq(learningProgress.userId, 1))
    )
    .where(where)
    .orderBy(desc(materials.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  /* 分母兜底：存量就绪材料 sentence_count 可空（schema 允许 NULL），缺失时现数
   * cues 作分母（与 /api/home resume 路径同口径）——否则老材料位图口径进度恒 0%，
   * 「已完卷」筛选永远筛不出整篇听过的老材料 */
  const cueCounts = new Map<number, number>();
  const missingIds = rows.filter((r) => r.sentenceCount === null).map((r) => r.id);
  if (missingIds.length > 0) {
    for (const cr of db
      .select({ materialId: cues.materialId, n: sql<number>`count(*)` })
      .from(cues)
      .where(inArray(cues.materialId, missingIds))
      .groupBy(cues.materialId)
      .all()) {
      cueCounts.set(cr.materialId, cr.n);
    }
  }

  /* DTO 组装：有进度行才落 progress 对象（位图按句数截断口径与 /api/home 一致）；
   * blob() 列经 drizzle select 推断为 unknown，按 schema 实际类型（Buffer|null）收窄；
   * source_type/subtitle_status 为 text 列（合法值见 schema 行内注释），收窄到 core 枚举 */
  const out: MaterialListItem[] = rows.map((r) => {
    const mask = r.listenedMask as Buffer | null;
    const total = r.sentenceCount ?? cueCounts.get(r.id) ?? 0;
    return {
      id: r.id,
      title: r.title,
      sourceType: r.sourceType as MaterialSourceType,
      mediaMime: r.mediaMime,
      mediaDurationMs: r.mediaDurationMs,
      subtitleStatus: r.subtitleStatus as SubtitleStatus,
      sentenceCount: r.sentenceCount,
      uniqueWordCount: r.uniqueWordCount,
      /* timestamp_ms 列运行时为 Date，序列化后即 DTO 契约的 ISO 字符串 */
      createdAt: r.createdAt.toISOString(),
      progress:
        r.progressUpdatedAt === null
          ? null
          : {
              maxCueIndex: r.maxCueIndex ?? 0,
              listenedThrough: Boolean(r.listenedThrough),
              /* 无位图存量行按 maxCueIndex+1 估算（estimateHeardNoMask 与
                 /api/home 三处同口径，防卷首缎带 >0% 而该材料行恒「未研读」
                 的跨面漂移） */
              progressPct: progressPct(
                mask ? countListenedBits(mask, total) : estimateHeardNoMask(r.maxCueIndex, total),
                total,
              ),
            },
    };
  });

  return NextResponse.json({
    materials: out,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}
