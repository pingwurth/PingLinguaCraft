/**
 * 任务 API：GET /api/jobs（活跃任务列表，惰性触发崩溃恢复）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/db/schema';
import { recoverStaleJobs } from '@/lib/jobs/pipeline';

export const runtime = 'nodejs';

/**
 * GET —— ?materialId= 过滤活跃任务（queued/running）或最近 50 条
 */
export async function GET(request: Request) {
  recoverStaleJobs(); // 惰性恢复：web 进程重启后未终态任务重跑（幂等管线）
  const url = new URL(request.url);
  const materialId = url.searchParams.get('materialId');
  const db = getDb();

  const base = db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      progress: jobs.progress,
      message: jobs.message,
      error: jobs.error,
      materialId: jobs.materialId,
      cueId: jobs.cueId,
      createdAt: jobs.createdAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs);

  const rows = materialId
    ? base
        .where(
          and(
            eq(jobs.materialId, Number(materialId)),
            inArray(jobs.status, ['queued', 'running', 'failed'])
          )
        )
        .orderBy(desc(jobs.createdAt))
        .limit(20)
        .all()
    : base
        .where(inArray(jobs.status, ['queued', 'running']))
        .orderBy(desc(jobs.createdAt))
        .limit(50)
        .all();

  return NextResponse.json({ jobs: rows });
}
