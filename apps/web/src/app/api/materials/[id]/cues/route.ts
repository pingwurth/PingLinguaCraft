/**
 * 材料 cues API：GET 全量句段（播放页装载一次拉全）
 * POST 新增句段（工坊「下方插入」；index 事务性重排）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET /api/materials/[id]/cues —— 全量句段（按 index 升序；wordsJson 解析为数组）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const rows = db
    .select()
    .from(cues)
    .where(eq(cues.materialId, Number(id)))
    .all()
    .sort((a, b) => a.index - b.index);
  return NextResponse.json({
    cues: rows.map((r) => ({
      ...r,
      words: r.wordsJson ? JSON.parse(r.wordsJson) : null,
      wordsJson: undefined,
    })),
  });
}

/**
 * POST /api/materials/[id]/cues —— 在指定 index 前插入空句段
 * Body: { afterIndex?: number, startMs?, endMs?, textEn?, textZh? }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as {
    afterIndex?: number;
    startMs?: number;
    endMs?: number;
    textEn?: string;
    textZh?: string;
  };
  const db = getDb();
  const materialId = Number(id);
  const rows = db
    .select()
    .from(cues)
    .where(eq(cues.materialId, materialId))
    .all()
    .sort((a, b) => a.index - b.index);
  const insertAt = Math.min(rows.length, (body.afterIndex ?? rows.length - 1) + 1);
  const now = new Date();

  const created = db.transaction((tx) => {
    // 后续句段 index 顺移
    for (let i = rows.length - 1; i >= insertAt; i--) {
      tx.update(cues)
        .set({ index: i + 1, updatedAt: now })
        .where(eq(cues.id, rows[i]!.id))
        .run();
    }
    const r = tx
      .insert(cues)
      .values({
        userId: 1,
        materialId,
        index: insertAt,
        startMs: body.startMs ?? rows[insertAt - 1]?.endMs ?? 0,
        endMs: body.endMs ?? (body.startMs ?? rows[insertAt - 1]?.endMs ?? 0) + 2000,
        textEn: body.textEn ?? '',
        textZh: body.textZh ?? null,
        isEdited: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: cues.id })
      .all();
    return r[0]!.id;
  });
  return NextResponse.json({ id: created }, { status: 201 });
}
