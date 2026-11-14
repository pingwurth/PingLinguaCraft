/**
 * 单句重 STT API：POST /api/cues/[id]/restt —— 管线任务（切片重听写替换原文）
 */

import { NextResponse } from 'next/server';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';

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
  const cueId = Number(id);
  const jobId = createJob({
    type: 'restt_cue',
    cueId,
    payload: { sttProfileId: body.sttProfileId, extendMs: body.extendMs },
  });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}
