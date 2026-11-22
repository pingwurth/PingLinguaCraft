/**
 * 单个材料 API：GET 详情（含学习进度，播放页装载）/ PATCH（更新 + 移动卷）/ DELETE 软删
 */

import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { collections, jobs, learningProgress, materials } from '@/lib/db/schema';
import { parseIdParam, readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET /api/materials/[id] —— 材料详情 + 学习进度
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const row = db.select().from(materials).where(eq(materials.id, pid)).all()[0];
  if (!row || row.deletedAt) return NextResponse.json({ error: '材料不存在' }, { status: 404 });
  const progress = db
    .select()
    .from(learningProgress)
    .where(eq(learningProgress.materialId, row.id))
    .all()[0] ?? null;
  return NextResponse.json({ material: row, progress });
}

/**
 * 库内路径迁移改写：`<oldCid>/<matId>/…` 前缀换挂到目标卷
 *
 * media_path / peaks_path / recordings.file_path 的存储契约都是相对
 * MEDIA_ROOT、前两段为 collectionId/materialId（见 lib/server/media.ts）。
 * @param rel    原库内路径
 * @param from   原属卷 id
 * @param to     目标卷 id
 * @param matId  材料 id
 * @returns 前缀不符的异常形态原样返回（不虚构合法前缀掩盖问题）
 */
function remapMediaRel(rel: string, from: number, to: number, matId: number): string {
  const prefix = `${from}/${matId}`;
  return rel.startsWith(`${prefix}/`) ? `${to}/${matId}${rel.slice(prefix.length)}` : rel;
}

/**
 * PATCH /api/materials/[id] —— 更新标题/描述；collectionId 变更即移动材料：
 * 校验目标卷与任务占用 → 媒体目录整体 rename 迁移（先文件后库，库失败回迁目录）
 * → 事务改写 collectionId 与 media_path / peaks_path / recordings.file_path 三处
 * 库内路径前缀，媒体/波形/跟读录音随材料一并迁移。
 * Body: { title?, description?, collectionId? }
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = await readJsonBody<Record<string, unknown>>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const db = getDb();

  /* 移动意图解析：目标卷 id 必须是正整数；与现属卷相同视为纯更新（不迁移） */
  const targetId = body.collectionId !== undefined ? Number(body.collectionId) : null;
  if (targetId !== null && (!Number.isInteger(targetId) || targetId <= 0)) {
    return NextResponse.json({ error: 'collectionId 非法' }, { status: 400 });
  }

  /* 移动前置校验：材料存在未删、目标卷存在、无进行中任务。
   * 任务占用是硬闸——导入/重 STT/重译以绝对路径往材料目录写产物，迁移中
   * 改道会把产物散落旧路径（伪就绪/伪失败）；完成后再移 */
  const move =
    targetId !== null
      ? (() => {
          const row = db
            .select({ collectionId: materials.collectionId, deletedAt: materials.deletedAt })
            .from(materials)
            .where(eq(materials.id, pid))
            .all()[0];
          if (!row || row.deletedAt) return 'no-material' as const;
          if (row.collectionId === targetId) return null;
          const target = db
            .select({ id: collections.id })
            .from(collections)
            .where(and(eq(collections.id, targetId), eq(collections.userId, 1)))
            .all()[0];
          if (!target) return 'no-target' as const;
          const busy = db
            .select({ n: sql<number>`count(*)` })
            .from(jobs)
            .where(and(eq(jobs.materialId, pid), inArray(jobs.status, ['queued', 'running'])))
            .all()[0]!.n;
          if (busy > 0) return 'busy' as const;
          return { from: row.collectionId, to: targetId };
        })()
      : null;
  if (move === 'no-material') return NextResponse.json({ error: '材料不存在' }, { status: 404 });
  if (move === 'no-target') return NextResponse.json({ error: '目标材料集不存在' }, { status: 404 });
  if (move === 'busy') {
    return NextResponse.json(
      { error: '该材料有进行中的任务（字幕/翻译等），完成后再移动' },
      { status: 409 }
    );
  }

  /* 先迁目录后改库（同盘 rename 原子；文本材料无媒体目录则跳过）：
   * 库改写失败时目录迁回，尽最大努力不留「库指旧路径、文件已迁走」的死链 */
  let moved = false;
  if (move) {
    const oldDir = join(MEDIA_ROOT, String(move.from), String(pid));
    if (existsSync(oldDir)) {
      const newDir = join(MEDIA_ROOT, String(move.to), String(pid));
      try {
        mkdirSync(join(MEDIA_ROOT, String(move.to)), { recursive: true });
        renameSync(oldDir, newDir);
        moved = true;
      } catch (err) {
        return NextResponse.json(
          { error: `媒体目录迁移失败：${err instanceof Error ? err.message : String(err)}` },
          { status: 500 }
        );
      }
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ['title', 'description'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  try {
    db.transaction((tx) => {
      if (move) {
        // media_path/peaks_path 换挂目标卷；跟读录音（<cid>/<matId>/rec/…）同目录布局，SQL 批量改前缀
        const cur = tx
          .select({ mediaPath: materials.mediaPath, peaksPath: materials.peaksPath })
          .from(materials)
          .where(eq(materials.id, pid))
          .all()[0];
        if (cur?.mediaPath) patch.mediaPath = remapMediaRel(cur.mediaPath, move.from, move.to, pid);
        if (cur?.peaksPath) patch.peaksPath = remapMediaRel(cur.peaksPath, move.from, move.to, pid);
        const oldPrefix = `${move.from}/${pid}`;
        tx.run(
          sql`UPDATE recordings SET file_path = ${`${move.to}/${pid}`} || substr(file_path, ${oldPrefix.length + 1})
              WHERE material_id = ${pid} AND file_path LIKE ${`${oldPrefix}/%`}`
        );
        patch.collectionId = move.to;
      }
      tx.update(materials).set(patch).where(eq(materials.id, pid)).run();
    });
  } catch (err) {
    // 库改写失败回滚目录（迁回失败也已如实上报，避免静默不一致）
    if (moved) {
      try {
        renameSync(
          join(MEDIA_ROOT, String(move!.to), String(pid)),
          join(MEDIA_ROOT, String(move!.from), String(pid))
        );
      } catch {
        /* 迁回失败：文件留在目标卷目录而库指旧路径，错误随下方上抛可见 */
      }
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/materials/[id] —— 软删除（保留媒体可恢复；永久清理在 M2 的存储管理页）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  db.update(materials)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(materials.id, pid))
    .run();
  return NextResponse.json({ ok: true });
}
