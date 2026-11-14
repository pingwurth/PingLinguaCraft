/**
 * 整材料重 STT API（需求 9：支持整个音频/视频重新 STT）
 * POST /api/materials/[id]/restt  Body: { sttProfileId?, translateProfileId? }
 */

import { NextResponse } from 'next/server';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';

export const runtime = 'nodejs';

/**
 * POST —— 创建整材料重 STT 管线任务（重转写 → 重译 → 统计）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    sttProfileId?: number;
    translateProfileId?: number;
  };
  const jobId = createJob({
    type: 'restt',
    materialId: Number(id),
    payload: { sttProfileId: body.sttProfileId, translateProfileId: body.translateProfileId },
  });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}
