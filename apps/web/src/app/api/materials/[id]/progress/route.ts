/**
 * 学习进度 API：PUT /api/materials/[id]/progress
 * 播放页 5s 防抖 + pagehide 上报；listened_mask 位图驱动闯关解锁（需求 17）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { countListenedBits } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { cues, learningProgress } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * PUT —— Body: { lastPositionMs, maxCueIndex, listenedMask(base64), listenedThrough }
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as {
    lastPositionMs?: number;
    maxCueIndex?: number;
    listenedMask?: string; // base64 位图
    listenedThrough?: boolean;
  };
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
  let listenedThrough = Boolean(body.listenedThrough);
  if (maskBuf && total > 0) {
    // 位图置位数 ≥ 句段数才算「听过一遍」；只统计前 total 位（@pinglc/core
    // 单一口径，双端共享）。旧内联公式 (b&0x55)+((b>>1)&0x55) 不是 popcount——
    // 高位按位权放大，听 5 句能算出 26，闯关解锁复核形同虚设
    listenedThrough = countListenedBits(maskBuf, total) >= total;
  }

  const now = new Date();
  const existing = db
    .select({ id: learningProgress.id, firstDone: learningProgress.firstListenCompletedAt })
    .from(learningProgress)
    .where(eq(learningProgress.materialId, materialId))
    .all()[0];

  const values = {
    lastPositionMs: Math.max(0, Math.round(body.lastPositionMs ?? 0)),
    maxCueIndex: Math.max(0, Math.round(body.maxCueIndex ?? 0)),
    listenedMask: maskBuf,
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
