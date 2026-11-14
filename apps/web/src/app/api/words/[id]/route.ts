/**
 * 单词 API：PATCH（笔记/状态）/ DELETE；AI 笔记任务在 [id]/ai-note 子路由
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { words } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * PATCH —— Body: { noteMd?, status? }（Markdown 笔记编辑+预览，需求 14）
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { noteMd?: string | null; status?: string };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.noteMd !== undefined) patch.noteMd = body.noteMd;
  if (body.status !== undefined) patch.status = body.status;
  const db = getDb();
  db.update(words).set(patch).where(eq(words.id, Number(id))).run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE —— 删除单词
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  db.delete(words).where(eq(words.id, Number(id))).run();
  return NextResponse.json({ ok: true });
}
