/**
 * 单会话 API：GET 消息列表 / DELETE 删除会话
 */

import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiMessages, aiThreads } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET —— 全部消息（时间正序）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const thread = db
    .select()
    .from(aiThreads)
    .where(eq(aiThreads.id, pid))
    .all()[0];
  if (!thread) return NextResponse.json({ error: '会话不存在' }, { status: 404 });
  const messages = db
    .select({ id: aiMessages.id, role: aiMessages.role, contentMd: aiMessages.contentMd, createdAt: aiMessages.createdAt })
    .from(aiMessages)
    .where(eq(aiMessages.threadId, thread.id))
    .orderBy(asc(aiMessages.createdAt))
    .all();
  return NextResponse.json({ thread, messages });
}

/**
 * DELETE —— 删除会话（级联清消息）
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  db.delete(aiThreads).where(eq(aiThreads.id, pid)).run();
  return NextResponse.json({ ok: true });
}
