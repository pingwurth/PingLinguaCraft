/**
 * 材料集 API：GET 列表（含统计）/ POST 创建（需求 19）
 */

import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { coverSortOrderRank, serializeCollectionCover, type CollectionCoverConfig } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';
import { cleanCollectionTextFields } from '@/lib/server/collection-input';
import { readJsonBody } from '@/lib/server/params';
import { COLLECTION_NAME_MAX } from '@/lib/limits';

export const runtime = 'nodejs';

/**
 * GET /api/collections —— 材料集列表（每集含材料数/总时长/研习中数）
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      cover: collections.cover,
      cefrLevel: collections.cefrLevel,
      sortOrder: collections.sortOrder,
      createdAt: collections.createdAt,
      materialCount: sql<number>`(
        SELECT count(*) FROM ${materials}
        WHERE ${materials.collectionId} = ${collections.id} AND ${materials.deletedAt} IS NULL
      )`,
      totalDurationMs: sql<number>`(
        SELECT coalesce(sum(${materials.mediaDurationMs}), 0) FROM ${materials}
        WHERE ${materials.collectionId} = ${collections.id} AND ${materials.deletedAt} IS NULL
      )`,
    })
    .from(collections)
    .where(eq(collections.userId, 1))
    .orderBy(collections.sortOrder, collections.id)
    .all();
  return NextResponse.json({ collections: rows });
}

/**
 * POST /api/collections —— 创建材料集
 * Body: { name, description?, cefrLevel?, cover? }
 * cover 为封面配置对象（契约见 @pinglc/core serializeCollectionCover：
 * texture 质地 id / image covers/ 图路径 / seal 印文单字 / volume 册序文案），
 * 服务端清洗序列化后落库，非法字段静默丢弃，不透传原始输入。
 */
export async function POST(request: Request) {
  /* 请求体按宽类型收（文本字段由 cleanCollectionTextFields 逐字段收窄，
   * cover 在使用点 typeof 判定——预声明窄泛型再 as 回宽类型是自欺） */
  const body = await readJsonBody<Record<string, unknown>>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  /* 文本字段清洗与 PATCH 同源（此前两路各自为政，坏输入行为漂移）；POST 侧
   * name 缺失或清洗后为空都按「材料集名不能为空」拒绝，超长给专属提示
   * （先判超长：超长时 patch.name 未写，先判 undefined 会误报「不能为空」） */
  const { patch: textPatch, nameInvalid, nameTooLong, typeInvalid } = cleanCollectionTextFields(body);
  if (typeInvalid) return NextResponse.json({ error: '文本字段类型非法' }, { status: 400 });
  const name = textPatch.name;
  if (nameTooLong) {
    return NextResponse.json({ error: `材料集名超长（上限 ${COLLECTION_NAME_MAX} 字）` }, { status: 400 });
  }
  if (nameInvalid || name === undefined) return NextResponse.json({ error: '材料集名不能为空' }, { status: 400 });
  // 封面配置：对象形态必检（数组/原始值直接拒绝）；清洗后全字段非法同样 400
  // （与 PATCH 同口径——静默落 null 会让拼错字段的请求看似成功）
  let coverJson: string | null = null;
  if (body.cover !== undefined && body.cover !== null) {
    if (typeof body.cover !== 'object' || Array.isArray(body.cover)) {
      return NextResponse.json({ error: 'cover 封面配置非法' }, { status: 400 });
    }
    // 清洗后全字段非法（如 texture 拼错）按非法输入 400——与 PATCH 同口径，
    // 静默落 null 会让两端对同一份坏输入行为漂移
    coverJson = serializeCollectionCover(body.cover as CollectionCoverConfig);
    if (!coverJson) return NextResponse.json({ error: 'cover 封面配置非法' }, { status: 400 });
  }
  // 册序即真排序：sortOrder 由「落库的清洗后配置」卷签 rank 派生（卷壹=10 …
  // 别卷=90，coverSortOrderRank 与 PATCH 存卷共用单源）；不能取原始请求串——
  // serialize 归一别名卷签（「卷壹 · 启篇」→「卷壹」）后 exact 匹配会落空，
  // sortOrder 误归 0 排到真卷壹之前。未编排=不表达排序意图：新建无现值可保
  // 落默认 0；PATCH 存卷侧对未编排保留现值（不覆盖经 API 手工排过的卷）——
  // 两路是同一语义在「有无现值」上的自然分叉
  const sortOrder = coverSortOrderRank(coverJson) ?? 0;
  const db = getDb();
  const now = new Date();
  const r = db
    .insert(collections)
    .values({
      userId: 1,
      name,
      description: textPatch.description ?? null,
      cefrLevel: textPatch.cefrLevel ?? null,
      cover: coverJson,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: collections.id })
    .all();
  return NextResponse.json({ id: r[0]!.id }, { status: 201 });
}
