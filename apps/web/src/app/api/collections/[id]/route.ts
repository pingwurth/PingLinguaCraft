/**
 * 单个材料集 API：GET 详情 / PATCH 更新 / DELETE 删除（级联删材料与媒体由前端确认）
 */

import { NextResponse } from 'next/server';
import { rmSync } from 'node:fs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { coverVolumeRank, parseCollectionCover, serializeCollectionCover, type CollectionCoverConfig } from '@pinglc/core';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { collections, materials } from '@/lib/db/schema';
import { parseIdParam, readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET /api/collections/[id] —— 材料集详情
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const row = db
    .select()
    .from(collections)
    .where(and(eq(collections.id, pid), eq(collections.userId, 1)))
    .all()[0];
  if (!row) return NextResponse.json({ error: '材料集不存在' }, { status: 404 });
  /* 卷内统计回填（DTO Collection 契约声明 materialCount/totalDurationMs，此前直接回
     DB 行漏了这两字段——删除确认弹窗的级联篇数提示依赖 materialCount；
     口径与 /api/home 一致：软删材料不计） */
  const stats = db
    .select({
      materialCount: sql<number>`count(${materials.id})`,
      totalDurationMs: sql<number>`coalesce(sum(${materials.mediaDurationMs}), 0)`,
    })
    .from(materials)
    .where(and(eq(materials.collectionId, pid), isNull(materials.deletedAt)))
    .get();
  return NextResponse.json({ collection: { ...row, ...stats } });
}

/**
 * PATCH /api/collections/[id] —— 更新材料集（name/description/cover/cefrLevel/sortOrder）
 * cover 为封面配置对象（契约同 POST /api/collections），传 null 清空封面
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = await readJsonBody<Record<string, unknown>>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ['name', 'description', 'cefrLevel'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  // 封面配置：清洗序列化后落库。清洗后全字段非法（空串）按非法输入 400 拒绝
  // 而非静默置 null——字段拼错（如 texture:'linen2'）会把既有封面（插画/印文/
  // 册序）整条抹掉却仍回 ok；只有显式传 null 才走清空分支
  if (body.cover !== undefined) {
    if (body.cover === null) {
      patch.cover = null;
    } else if (typeof body.cover === 'object' && !Array.isArray(body.cover)) {
      const serialized = serializeCollectionCover(body.cover as CollectionCoverConfig);
      if (!serialized) return NextResponse.json({ error: 'cover 封面配置非法' }, { status: 400 });
      patch.cover = serialized;
    } else {
      return NextResponse.json({ error: 'cover 封面配置非法' }, { status: 400 });
    }
  }
  // sortOrder：显式传入则收整数（Number 强转会放过 [3]/true 之类结构非法值）；
  // 未传但本次改了封面时，由清洗后卷签重算（与 POST 同源——「册序即真排序」
  // 不应只靠前端记得传 sortOrder 维持），卷签未编排则保留现值不强行归 0
  if (body.sortOrder !== undefined) {
    // 先验 JSON 类型再验整数：裸 Number 强转会放过 true/[3]/null 之类
    // （null→0 会静默把卷顶到书架最前）
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
      return NextResponse.json({ error: 'sortOrder 必须是整数' }, { status: 400 });
    }
    patch.sortOrder = body.sortOrder;
  } else if (typeof patch.cover === 'string') {
    const ranked = coverVolumeRank(parseCollectionCover(patch.cover)?.volume ?? '');
    if (ranked !== null) patch.sortOrder = ranked;
  }
  db.update(collections)
    .set(patch)
    .where(and(eq(collections.id, pid), eq(collections.userId, 1)))
    .run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/collections/[id] —— 删除材料集（物理删：SQLite 级联清 cues 等；媒体目录一并清理）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const cid = parseIdParam(id);
  if (cid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  // 先收集媒体目录信息（级联删除后无法再查）
  const mats = db
    .select({ id: materials.id })
    .from(materials)
    .where(eq(materials.collectionId, cid))
    .all();
  const del = db.delete(collections).where(and(eq(collections.id, cid), eq(collections.userId, 1))).run();
  // 删除未生效（id 非法/不存在/非本人材料集）→ 不动磁盘，返回 404。
  // 此前 0 行删除仍无条件 rmSync：NaN/越权路径会把既有媒体目录清掉而 DB 行
  // 还在——数据不一致；多用户化后会误删他人目录
  if (del.changes === 0) {
    return NextResponse.json({ error: '材料集不存在' }, { status: 404 });
  }
  // 清理媒体目录（best-effort；库行已删，目录残留无害但占磁盘）
  for (const m of mats) {
    try {
      rmSync(`${MEDIA_ROOT}/${cid}/${m.id}`, { recursive: true, force: true });
    } catch {
      /* 目录缺失/权限问题忽略 */
    }
  }
  try {
    rmSync(`${MEDIA_ROOT}/${cid}`, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  return NextResponse.json({ ok: true });
}
