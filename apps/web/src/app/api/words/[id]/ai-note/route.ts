/**
 * 单词 AI 笔记 API：POST /api/words/[id]/ai-note（需求 14：支持 AI 自动生成单词笔记）
 */

import { NextResponse } from 'next/server';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 创建 AI 笔记生成任务（LLM 档案）
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const jobId = createJob({ type: 'ai_note', payload: { wordId } });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}
