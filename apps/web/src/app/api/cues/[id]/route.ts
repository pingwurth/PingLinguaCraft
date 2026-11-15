/**
 * 单句段 API：PATCH 人工纠错（原文/译文/时间/笔记）/ DELETE 删除（index 重排）
 * 需求 9：支持单条字幕人工纠错（原文、译文、时间、新增、删除）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * PATCH /api/cues/[id] —— 更新句段字段
 * Body: { startMs?, endMs?, textEn?, textZh?, noteMd?, clearTranslation? }
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json()) as {
    startMs?: number;
    endMs?: number;
    textEn?: string;
    textZh?: string | null;
    noteMd?: string | null;
    clearTranslation?: boolean;
  };
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const edited: string[] = [];
  if (body.startMs !== undefined) {
    // 有限数守卫：Math.round(非数值)=NaN 会以 NULL 绑定撞 NOT NULL 约束变 500
    if (!Number.isFinite(body.startMs)) {
      return NextResponse.json({ error: 'startMs 非法' }, { status: 400 });
    }
    patch.startMs = Math.max(0, Math.round(body.startMs));
    edited.push('时间');
  }
  if (body.endMs !== undefined) {
    if (!Number.isFinite(body.endMs)) {
      return NextResponse.json({ error: 'endMs 非法' }, { status: 400 });
    }
    patch.endMs = Math.max(0, Math.round(body.endMs));
    edited.push('时间');
  }
  if (body.textEn !== undefined) {
    patch.textEn = body.textEn;
    edited.push('原文');
  }
  if (body.textZh !== undefined) {
    patch.textZh = body.textZh;
    edited.push('译文');
  }
  if (body.clearTranslation) {
    patch.textZh = null;
    patch.translationProvider = null;
    edited.push('译文');
  }
  if (body.noteMd !== undefined) patch.noteMd = body.noteMd;
  // 有人工内容修改时置 isEdited（工坊显示「已纠错」标记）
  if (edited.length > 0) patch.isEdited = true;
  db.update(cues).set(patch).where(eq(cues.id, pid)).run();
  return NextResponse.json({ ok: true, edited });
}

/**
 * DELETE /api/cues/[id] —— 删除句段（后续 index 事务性前移）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const cueId = parseIdParam(id);
  if (cueId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const target = db.select().from(cues).where(eq(cues.id, cueId)).all()[0];
  if (!target) return NextResponse.json({ error: '句段不存在' }, { status: 404 });
  const rows = db
    .select()
    .from(cues)
    .where(eq(cues.materialId, target.materialId))
    .all()
    .sort((a, b) => a.index - b.index);
  const now = new Date();
  db.transaction((tx) => {
    tx.delete(cues).where(eq(cues.id, cueId)).run();
    // 后续句段 index 前移
    for (const row of rows) {
      if (row.index > target.index) {
        tx.update(cues)
          .set({ index: row.index - 1, updatedAt: now })
          .where(eq(cues.id, row.id))
          .run();
      }
    }
  });
  return NextResponse.json({ ok: true });
}
