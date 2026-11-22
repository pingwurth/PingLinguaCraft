/**
 * 全局检索 API：GET /api/search?q=…
 *
 * 桌面顶栏检索框（设计稿 linguacraft_10）的数据源，两组命中一次返回：
 * - collections：卷名 LIKE 命中的材料集（附未删除材料数）
 * - materials：标题 LIKE 命中的材料（附所属集与字幕状态）
 *
 * 口径与首页聚合一致：userId=1（单用户约定）、materials 排除软删除；
 * LIKE 通配符（% _ \）转义后交 ESCAPE 匹配原文字面。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';
import { SEARCH_QUERY_MAX, type SearchMaterialHit, type SearchResults } from '@/features/search/types';

export const runtime = 'nodejs';

/** 检索词长度上限（超长直接拒绝，防误粘整段文本打爆 LIKE 扫描） */
const MAX_QUERY_LENGTH = SEARCH_QUERY_MAX;

/** 材料集命中条数上限 */
const COLLECTION_LIMIT = 6;

/** 材料命中条数上限 */
const MATERIAL_LIMIT = 8;

/**
 * 检索词 → LIKE 匹配模式：两端包裹 %，通配符字面转义
 * （% _ \ 前加反斜杠，SQL 侧以 ESCAPE '\' 声明转义字符）
 * @param q 已 trim 的检索词
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * GET —— 全局检索
 * @param request 带 ?q= 检索词的请求（空词返回空命中，不视为错误）
 */
export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: `检索词过长（上限 ${MAX_QUERY_LENGTH} 字）` }, { status: 400 });
  }
  // 空词直接空命中：顶栏在防抖后仅在非空时请求，此处兜底防直连调用
  if (!q) {
    return NextResponse.json({ collections: [], materials: [] } satisfies SearchResults);
  }

  const db = getDb();
  const pattern = likePattern(q);

  /* 卷名命中：材料集 + 未删除材料计数（口径同首页集卷列表） */
  const collectionRows = db
    .select({
      id: collections.id,
      name: collections.name,
      materialCount: sql<number>`count(${materials.id})`,
    })
    .from(collections)
    .leftJoin(
      materials,
      and(eq(materials.collectionId, collections.id), isNull(materials.deletedAt))
    )
    .where(
      and(eq(collections.userId, 1), sql`${collections.name} like ${pattern} escape '\\'`)
    )
    .groupBy(collections.id)
    .orderBy(collections.sortOrder, collections.id)
    .limit(COLLECTION_LIMIT)
    .all();

  /* 标题命中：未删除材料 + 所属集名，最近更新在前（最可能正要找的排上面） */
  const materialRows = db
    .select({
      id: materials.id,
      title: materials.title,
      sourceType: materials.sourceType,
      subtitleStatus: materials.subtitleStatus,
      collectionId: collections.id,
      collectionName: collections.name,
    })
    .from(materials)
    .innerJoin(collections, eq(collections.id, materials.collectionId))
    .where(
      and(
        eq(materials.userId, 1),
        isNull(materials.deletedAt),
        sql`${materials.title} like ${pattern} escape '\\'`
      )
    )
    .orderBy(desc(materials.updatedAt))
    .limit(MATERIAL_LIMIT)
    .all();

  const data: SearchResults = {
    collections: collectionRows,
    materials: materialRows.map(
      (r): SearchMaterialHit => ({
        id: r.id,
        title: r.title,
        // text 列经 drizzle 推断为 string，按 core 枚举收窄（口径同首页流动动向）
        sourceType: r.sourceType as SearchMaterialHit['sourceType'],
        // text 列经 drizzle 推断为 string，按 schema 枚举收窄（口径同首页流动动向）
        subtitleStatus: r.subtitleStatus as SearchMaterialHit['subtitleStatus'],
        collectionId: r.collectionId,
        collectionName: r.collectionName,
      })
    ),
  };
  return NextResponse.json(data);
}
