/**
 * 单句重 STT API：POST /api/cues/[id]/restt —— 管线任务（切片重听写替换原文）
 */

import { NextResponse } from 'next/server';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 创建单句重 STT 任务并启动管线
 * Body: { sttProfileId?, extendMs? }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    sttProfileId?: number;
    extendMs?: number;
  };
  const cueId = parseIdParam(id);
  if (cueId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const jobId = createJob({
    type: 'restt_cue',
    cueId,
    payload: { sttProfileId: body.sttProfileId, extendMs: body.extendMs },
  });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}
