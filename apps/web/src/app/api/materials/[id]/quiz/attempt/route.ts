/**
 * 测验作答 API：POST 判分落库（错题入 quiz_attempts）/ GET 错题列表
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, quizAttempts } from '@/lib/db/schema';
import { gradeAnswer, QuizSchema, type QuizQuestion } from '@/lib/quiz';

export const runtime = 'nodejs';

/**
 * POST —— 提交整卷作答：逐题判分落库；qa 题初始记未掌握，
 * 用户对照参考答案后经 /self-check 回写自评
 * Body: { artifactId, answers: (number|string|null)[] }
 * Returns: { results: {index, correct, reference?, attemptId}[], correctCount, total }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const materialId = Number(id);
  const body = (await request.json()) as { artifactId?: number; answers?: Array<number | string | null> };
  const answers = body.answers ?? [];

  const db = getDb();
  // 归属校验：测验产物必须属于本材料（否则跨材料错题污染本材料的错题本）
  const artifact = db
    .select()
    .from(aiArtifacts)
    .where(
      and(
        eq(aiArtifacts.id, Number(body.artifactId)),
        eq(aiArtifacts.kind, 'quiz'),
        eq(aiArtifacts.subjectType, 'material'),
        eq(aiArtifacts.subjectId, materialId)
      )
    )
    .all()[0];
  if (!artifact) return NextResponse.json({ error: '测验不存在' }, { status: 404 });

  const quiz = QuizSchema.parse(JSON.parse(artifact.contentMd!));
  const results: Array<{ index: number; correct: boolean; reference?: string; attemptId: number }> = [];
  let correctCount = 0;

  for (let i = 0; i < quiz.questions.length; i++) {
    const q: QuizQuestion = quiz.questions[i]!;
    const ans = answers[i] ?? null;
    // qa 交卷时未自评 → 先记未掌握（self-check 接口回写掌握）
    const correct = q.type === 'qa' ? false : gradeAnswer(q, ans);
    if (correct) correctCount++;
    const inserted = db
      .insert(quizAttempts)
      .values({
        userId: 1,
        materialId,
        artifactId: artifact.id,
        questionType: q.type,
        questionJson: JSON.stringify(q),
        userAnswer: ans === null ? null : String(ans),
        isCorrect: correct,
        createdAt: new Date(),
      })
      .returning({ id: quizAttempts.id })
      .all();
    results.push({
      index: i,
      correct,
      reference: q.type === 'choice' ? q.options[q.answer] : q.type === 'cloze' ? q.answer : q.referenceAnswer,
      attemptId: inserted[0]!.id,
    });
  }
  return NextResponse.json({ results, correctCount, total: quiz.questions.length });
}

/**
 * GET —— 该材料的错题列表（新→旧，最多 50 条）
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const rows = db
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.materialId, Number(id)), eq(quizAttempts.isCorrect, false)))
    .orderBy(desc(quizAttempts.createdAt))
    .limit(50)
    .all();
  return NextResponse.json({
    wrong: rows.map((r) => ({
      id: r.id,
      type: r.questionType,
      question: JSON.parse(r.questionJson),
      userAnswer: r.userAnswer,
      createdAt: r.createdAt,
    })),
  });
}
