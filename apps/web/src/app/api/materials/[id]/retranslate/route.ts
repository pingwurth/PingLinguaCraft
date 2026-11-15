/**
 * 整材料重翻译 API（需求 9：所有字幕重新翻译）
 * POST /api/materials/[id]/retranslate  Body: { force?, translateProfileId? }
 */

import { NextResponse } from 'next/server';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 创建整材料重译管线任务（force=true 清空全部译文重译）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as {
    force?: boolean;
    translateProfileId?: number;
  };
  const jobId = createJob({
    type: 'retranslate',
    materialId: pid,
    payload: { force: Boolean(body.force), translateProfileId: body.translateProfileId },
  });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}
