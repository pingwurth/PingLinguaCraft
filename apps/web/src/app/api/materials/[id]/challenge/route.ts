/**
 * 闯关 API（需求 17）
 * GET  /api/materials/[id]/challenge —— 解锁状态 + 各玩法最好成绩 + 句段总数
 * POST /api/materials/[id]/challenge  Body: { mode, score, detail? } —— 记录成绩（保底取高）
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { challengeRecords, cues, learningProgress, materials } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/** 六玩法标识 */
const MODES = ['grid', 'dictation', 'shadow_score', 'shadowing', 'recite', 'scenario'] as const;

/**
 * GET —— 闯关面板状态
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const materialId = parseIdParam(id);
  if (materialId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();

  const progress = db
    .select({ listenedThrough: learningProgress.listenedThrough })
    .from(learningProgress)
    .where(eq(learningProgress.materialId, materialId))
    .all()[0];
  const total = db.select({ id: cues.id }).from(cues).where(eq(cues.materialId, materialId)).all().length;
  const records = db
    .select({ mode: challengeRecords.mode, score: challengeRecords.score, createdAt: challengeRecords.createdAt })
    .from(challengeRecords)
    .where(eq(challengeRecords.materialId, materialId))
    .all();
  return NextResponse.json({
    unlocked: progress?.listenedThrough ?? false,
    totalCues: total,
    scores: Object.fromEntries(records.map((r) => [r.mode, r.score])),
  });
}

/**
 * POST —— 记录玩法成绩（同玩法取历史最高）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const materialId = parseIdParam(id);
  if (materialId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json()) as { mode?: string; score?: number; detail?: unknown };
  const mode = body.mode ?? '';
  if (!(MODES as readonly string[]).includes(mode)) {
    return NextResponse.json({ error: `玩法必须为 ${MODES.join('/')}` }, { status: 400 });
  }
  // score 严格数值校验：NaN 落库会触发 NOT NULL 约束变 500，前置为 400
  const raw = Number(body.score);
  if (!Number.isFinite(raw)) {
    return NextResponse.json({ error: 'score 必须为数字' }, { status: 400 });
  }
  const db = getDb();
  // 材料存在性：伪造 id 会撞外键约束变 500，前置为 404
  const material = db
    .select({ id: materials.id })
    .from(materials)
    .where(eq(materials.id, materialId))
    .all()[0];
  if (!material) return NextResponse.json({ error: '材料不存在' }, { status: 404 });

  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const existing = db
    .select({ id: challengeRecords.id, score: challengeRecords.score })
    .from(challengeRecords)
    .where(and(eq(challengeRecords.materialId, materialId), eq(challengeRecords.mode, mode)))
    .all()[0];
  if (existing) {
    if (score > existing.score) {
      db.update(challengeRecords)
        .set({
          score,
          detailJson: body.detail ? JSON.stringify(body.detail) : null,
          createdAt: new Date(),
        })
        .where(eq(challengeRecords.id, existing.id))
        .run();
    }
    return NextResponse.json({ ok: true, best: Math.max(score, existing.score) });
  }
  db.insert(challengeRecords)
    .values({
      userId: 1,
      materialId,
      mode,
      score,
      detailJson: body.detail ? JSON.stringify(body.detail) : null,
      createdAt: new Date(),
    })
    .run();
  return NextResponse.json({ ok: true, best: score });
}
