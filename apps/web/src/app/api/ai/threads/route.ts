/**
 * 侍读会话列表 API：GET /api/ai/threads（新→旧）
 */

import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiMessages, aiThreads } from '@/lib/db/schema';

export const runtime = 'nodejs';

/**
 * GET —— 会话列表（含最后一条消息预览与时间）
 */
export async function GET() {
  const db = getDb();
  const threads = db
    .select()
    .from(aiThreads)
    .where(eq(aiThreads.userId, 1))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(50)
    .all();
  const out = threads.map((t) => {
    const last = db
      .select({ role: aiMessages.role, contentMd: aiMessages.contentMd })
      .from(aiMessages)
      .where(eq(aiMessages.threadId, t.id))
      .orderBy(desc(aiMessages.createdAt))
      .limit(1)
      .all()[0];
    return {
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      preview: last?.contentMd?.slice(0, 60) ?? '',
    };
  });
  return NextResponse.json({ threads: out });
}
