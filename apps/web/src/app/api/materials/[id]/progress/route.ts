/**
 * 学习进度 API：PUT /api/materials/[id]/progress
 * 播放页 5s 防抖 + pagehide 上报；listened_mask 位图驱动闯关解锁（需求 17）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { countListenedBits } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { cues, learningProgress } from '@/lib/db/schema';
import { parseIdParam, readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * PUT —— Body: { lastPositionMs, maxCueIndex, listenedMask(base64), listenedThrough }
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJsonBody<{
    lastPositionMs?: number;
    maxCueIndex?: number;
    listenedMask?: string; // base64 位图
    listenedThrough?: boolean;
  }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const materialId = parseIdParam(id);
  if (materialId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();

  // 服务端复核「听过一遍」：位图置位数 ≥ 句段数（不信任客户端单方面声明）
  let maskBuf: Buffer | null = null;
  if (body.listenedMask) {
    try {
      maskBuf = Buffer.from(body.listenedMask, 'base64');
    } catch {
      maskBuf = null;
    }
  }
  const total = db
    .select({ id: cues.id })
    .from(cues)
    .where(eq(cues.materialId, materialId))
    .all().length;
  const now = new Date();
  const existing = db
    .select({
      id: learningProgress.id,
      firstDone: learningProgress.firstListenCompletedAt,
      listenedMask: learningProgress.listenedMask,
      listenedThrough: learningProgress.listenedThrough,
    })
    .from(learningProgress)
    .where(eq(learningProgress.materialId, materialId))
    .all()[0];

  // 位图合并：进度是累积语义——本次上报与库中旧位图按位或后再复核
  //（旧实现恒写 maskBuf：未带 mask 的上报会把已有位图覆盖成 NULL，进度丢失）
  let mask: Buffer | null = maskBuf;
  const oldMask = existing?.listenedMask;
  if (oldMask instanceof Buffer && oldMask.length > 0) {
    if (!mask) {
      mask = Buffer.from(oldMask);
    } else {
      const merged = Buffer.alloc(Math.max(mask.length, oldMask.length));
      for (let i = 0; i < merged.length; i++) {
        merged[i] = (mask[i] ?? 0) | (oldMask[i] ?? 0);
      }
      mask = merged;
    }
  }
  let listenedThrough: boolean;
  if (mask && total > 0) {
    // 位图置位数 ≥ 句段数才算「听过一遍」；只统计前 total 位（@pinglc/core
    // 单一口径，双端共享）。旧内联公式 (b&0x55)+((b>>1)&0x55) 不是 popcount——
    // 高位按位权放大，听 5 句能算出 26，闯关解锁复核形同虚设
    listenedThrough = countListenedBits(mask, total) >= total;
  } else {
    // 无位图可复核：保留库中既有判定（单调不回退），不采信客户端单方面声明
    listenedThrough = existing?.listenedThrough ?? false;
  }

  /** 数值字段三态补丁单源（maxCueIndex 与 lastPositionMs 同口径）：合法
   *  非负有限数 → 落取整值；省略/非法且是存量行（闭包内 existing）→ 不写
   *  该列（不良上报不得抹掉书签现值）；省略/非法且是新行 → 落 newRowDefault。
   *  负数（旧版上报器的 -1 哨兵）与 NaN 都按非法处理（NaN 绑 NOT NULL 列会 500）
   *  @param key        落库列名（限定两列，写错编译期拦下）
   *  @param raw        请求体原值
   *  @param newRowDefault 新行的默认值
   */
  const numericPatch = (
    key: 'maxCueIndex' | 'lastPositionMs',
    raw: unknown,
    newRowDefault: number,
  ): { maxCueIndex?: number; lastPositionMs?: number } => {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return { [key]: Math.round(raw) };
    if (existing) return {};
    return { [key]: newRowDefault };
  };
  const maxCuePatch = numericPatch('maxCueIndex', body.maxCueIndex, -1);

  const values = {
    ...numericPatch('lastPositionMs', body.lastPositionMs, 0),
    ...maxCuePatch,
    listenedMask: mask,
    listenedThrough,
    ...(listenedThrough && !existing?.firstDone ? { firstListenCompletedAt: now } : {}),
    updatedAt: now,
  };
  if (existing) {
    db.update(learningProgress).set(values).where(eq(learningProgress.id, existing.id)).run();
  } else {
    db.insert(learningProgress)
      .values({ userId: 1, materialId, ...values })
      .run();
  }
  return NextResponse.json({ ok: true, listenedThrough });
}
