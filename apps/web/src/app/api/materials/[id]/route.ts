/**
 * 单个材料 API：GET 详情（含学习进度，播放页装载）/ PATCH（更新 + 移动卷）/ DELETE 软删
 */

import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import { collections, cues, jobs, learningProgress, materials, recordings } from '@/lib/db/schema';
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

/** 任务占用复检命中（事务内抛出 → 外层 catch 回迁目录后按 409 返回，与前置检查同语义） */
class BusyError extends Error {}

/**
 * 该材料在跑任务数（材料级 + restt_cue 句级）：移卷前置检查（db 直连）与
 * 改库事务内复检（tx）共用同一判定——两份手抄副本会在口径调整时只改其一
 * @param executor 数据库直连或事务执行器
 * @param pid      材料 id
 * @returns 在跑任务总数（>0 即占用）
 */
function countActiveJobs(executor: Pick<ReturnType<typeof getDb>, 'select'>, pid: number): number {
  const busy = executor
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .where(and(eq(jobs.materialId, pid), inArray(jobs.status, ['queued', 'running'])))
    .all()[0]!.n;
  // 句级任务（restt_cue）不带 material_id，但其 cue_id 列可关联 cues 判定
  // 归属：单句重 STT 同样往材料目录写切片产物，迁移同样要挡（SQL 侧
  // 关联判定，不把全部在跑任务拉进 JS 过滤）
  const cueBusy = executor
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .innerJoin(cues, eq(cues.id, jobs.cueId))
    .where(and(eq(jobs.type, 'restt_cue'), inArray(jobs.status, ['queued', 'running']), eq(cues.materialId, pid)))
    .all()[0]!.n;
  return busy + cueBusy;
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

  /* 移动意图解析：目标卷 id 必须是正整数（先验 JSON 类型再收——裸 Number
   * 强转会放过 [3]/true 之类结构非法值并静默移卷）；与现属卷相同视为纯更新 */
  const rawTarget = body.collectionId;
  if (rawTarget !== undefined && (typeof rawTarget !== 'number' || !Number.isInteger(rawTarget) || rawTarget <= 0)) {
    return NextResponse.json({ error: 'collectionId 非法' }, { status: 400 });
  }
  const targetId = rawTarget ?? null;

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
          if (countActiveJobs(db, pid) > 0) return 'busy' as const;
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

  /* 路径校验先于目录迁移：media/peaks/recordings 路径若与 `<from>/<pid>/`
   * 前缀不符（历史脏数据），迁完后 remap/LIKE 改写会原样保留旧前缀 →
   * 「库指旧路径、文件已迁走」的死链还回 200（recordings 的 LIKE 前缀改写
   * 匹配不到的行会静默跳过，与 media/peaks 同类脏数据）。校验不过直接
   * 409，一个文件都不动 */
  let mediaPath: string | null = null;
  let peaksPath: string | null = null;
  if (move) {
    const cur = db
      .select({ mediaPath: materials.mediaPath, peaksPath: materials.peaksPath })
      .from(materials)
      .where(eq(materials.id, pid))
      .all()[0];
    mediaPath = cur?.mediaPath ?? null;
    peaksPath = cur?.peaksPath ?? null;
    const prefix = `${move.from}/${pid}/`;
    const badMedia = (mediaPath && !mediaPath.startsWith(prefix)) || (peaksPath && !peaksPath.startsWith(prefix));
    const badRecording = db
      .select({ n: sql<number>`count(*)` })
      .from(recordings)
      .where(and(eq(recordings.materialId, pid), sql`${recordings.filePath} NOT LIKE ${`${move.from}/${pid}/%`}`))
      .all()[0]!.n;
    if (badMedia || badRecording > 0) {
      return NextResponse.json(
        { error: '材料库内路径与所属卷不符（历史数据异常），请先修复路径再移动' },
        { status: 409 }
      );
    }
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
        /* 任务占用在事务内复检：前置检查与目录迁移之间存在窗口——另一标签页
         * 起的导入/重 STT 在此间落任务行，会往已迁走的旧绝对路径写产物（恰是
         * busy 闸要防的散落）。复检不过即抛 BusyError 回滚，目录由外层 catch
         * 回迁后按 409 返回 */
        if (countActiveJobs(tx, pid) > 0) {
          throw new BusyError('该材料有进行中的任务（字幕/翻译等），完成后再移动');
        }
        // media_path/peaks_path 换挂目标卷（前缀已在迁移前校验通过）；跟读录音
        // （<cid>/<matId>/rec/…）同目录布局，SQL 批量改前缀
        if (mediaPath) patch.mediaPath = remapMediaRel(mediaPath, move.from, move.to, pid);
        if (peaksPath) patch.peaksPath = remapMediaRel(peaksPath, move.from, move.to, pid);
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
    // 库改写失败回滚目录；回滚失败必须留痕（文件在 <to>/<pid> 而库指 <from>/<pid>，
    // 材料会 404 且无线索），并按本路由统一的 { error } JSON 契约返回而非裸 throw
    if (moved && move) {
      try {
        renameSync(
          join(MEDIA_ROOT, String(move.to), String(pid)),
          join(MEDIA_ROOT, String(move.from), String(pid))
        );
      } catch (rollbackErr) {
        console.error(`[materials/${pid}] 移卷目录回滚失败（库未改写，文件滞留 ${move.to}/${pid}）：`, rollbackErr);
      }
    }
    // 任务占用复检命中：目录已回迁，与前置检查同一 409 语义（可重试），
    // 不混进「库路径改写失败 500」误报存储故障
    if (err instanceof BusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: `库路径改写失败：${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
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
