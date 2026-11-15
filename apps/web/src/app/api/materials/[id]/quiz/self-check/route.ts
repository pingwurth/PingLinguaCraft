/**
 * 问答自评回写 API：POST /api/materials/[id]/quiz/self-check
 * 两段式判分的第二段：交卷后对照参考答案自评「掌握/未掌握」
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { quizAttempts } from '@/lib/db/schema';
import { parseIdParam, readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— Body: { attemptId, correct }（attemptId 来自交卷响应）
 * 仅允许回写 qa 题自评：choice/cloze 的机器判分不可被客户端覆盖
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const materialId = parseIdParam(id);
  if (materialId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = await readJsonBody<{ attemptId?: number; correct?: boolean }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  if (!body.attemptId) return NextResponse.json({ error: '缺少 attemptId' }, { status: 400 });
  // 严格比较：Boolean("false") === true，必须只认真布尔
  if (body.correct !== true && body.correct !== false) {
    return NextResponse.json({ error: 'correct 必须为布尔值' }, { status: 400 });
  }

  const db = getDb();
  const row = db
    .select({ id: quizAttempts.id, questionType: quizAttempts.questionType })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.id, Number(body.attemptId)), eq(quizAttempts.materialId, materialId)))
    .all()[0];
  if (!row) return NextResponse.json({ error: '作答记录不存在' }, { status: 404 });
  if (row.questionType !== 'qa') {
    return NextResponse.json({ error: '仅问答题支持自评回写' }, { status: 403 });
  }

  db.update(quizAttempts)
    .set({ isCorrect: body.correct })
    .where(eq(quizAttempts.id, row.id))
    .run();
  return NextResponse.json({ ok: true });
}
