/**
 * 单词 API：PATCH（笔记/状态）/ DELETE；AI 笔记任务在 [id]/ai-note 子路由
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { words } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * PATCH —— Body: { noteMd?, status? }（Markdown 笔记编辑+预览，需求 14）
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json()) as { noteMd?: string | null; status?: string };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.noteMd !== undefined) patch.noteMd = body.noteMd;
  // status 必须对白名单校验后入库（直写会让任意字符串进 words.status，
  // 下游按状态过滤/统计的查询全部失真）
  const WORD_STATUSES = ['new', 'learning', 'review', 'mastered'] as const;
  if (body.status !== undefined) {
    if (!WORD_STATUSES.includes(body.status as (typeof WORD_STATUSES)[number])) {
      return NextResponse.json({ error: '非法的单词状态' }, { status: 400 });
    }
    patch.status = body.status;
  }
  const db = getDb();
  db.update(words).set(patch).where(eq(words.id, pid)).run();
  return NextResponse.json({ ok: true });
}

/**
 * DELETE —— 删除单词
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  db.delete(words).where(eq(words.id, pid)).run();
  return NextResponse.json({ ok: true });
}
