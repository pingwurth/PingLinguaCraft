/**
 * 单任务 API：GET /api/jobs/[id]（客户端 1.5s 轮询；惰性触发恢复）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/db/schema';
import { recoverStaleJobs } from '@/lib/jobs/pipeline';

export const runtime = 'nodejs';

/**
 * GET —— 任务当前状态（含 result 摘要）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  recoverStaleJobs();
  const db = getDb();
  const row = db.select().from(jobs).where(eq(jobs.id, id)).all()[0];
  if (!row) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  return NextResponse.json({
    job: {
      id: row.id,
      type: row.type,
      status: row.status,
      progress: row.progress,
      message: row.message,
      error: row.error,
      materialId: row.materialId,
      cueId: row.cueId,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    },
  });
}
