'use client';

/**
 * 「测验」标签页（需求 12：选择题、填空题、问答题）
 *
 * 流程：生成（LLM 任务，轮询进度）→ 作答（逐题交互）→ 交卷判分（服务端）
 * → 问答自评（对照参考答案「掌握/未掌握」，两段式）→ 成绩与解析 → 错题回顾。
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** 测验数据（与 lib/quiz 的 zod schema 对应的客户端形态） */
type QQuizData = {
  title: string;
  questions: Array<
    | { type: 'choice'; stem: string; options: string[]; answer: number; explanation: string }
    | { type: 'cloze'; sentence: string; answer: string; hint?: string; explanation: string }
    | { type: 'qa'; question: string; referenceAnswer: string; explanation?: string }
  >;
};

/** 判分结果项（attemptId 供问答自评回写） */
interface GradeResult {
  index: number;
  correct: boolean;
  reference?: string;
  attemptId: number;
}

/** 错题形态 */
interface WrongDTO {
  id: number;
  type: string;
  question: QQuizData['questions'][number];
  userAnswer: string | null;
  createdAt: string;
}

/**
 * 测验标签页
 * @param props.materialId 材料 id
 */
export function QuizTab({ materialId }: { materialId: number }) {
  const qc = useQueryClient();
  /** 作答数组（长度与题目数一致；换卷/重新生成时随 artifactId 重置） */
  const [answers, setAnswers] = useState<Array<number | string | null>>([]);
  const [submitted, setSubmitted] = useState(false);
  const [grade, setGrade] = useState<{ results: GradeResult[]; correctCount: number; total: number } | null>(null);
  /** 问答自评结果（attemptId → 是否掌握） */
  const [selfChecks, setSelfChecks] = useState<Record<number, boolean>>({});
  const [showWrong, setShowWrong] = useState(false);
  /** 生成任务 id（非空即轮询中） */
  const [genJobId, setGenJobId] = useState<string | null>(null);
  const [genStatus, setGenStatus] = useState<{ status: string; progress: number; message: string | null } | null>(null);

  /* 最新测验 */
  const quizQuery = useQuery({
    queryKey: ['quiz', materialId],
    queryFn: () => api<{ quiz: { artifactId: number; provider: string | null; data: QQuizData } | null; wrongCount: number }>(`/api/materials/${materialId}/quiz`),
  });

  const questions = quizQuery.data?.quiz?.data.questions ?? [];
  const artifactId = quizQuery.data?.quiz?.artifactId ?? null;

  /* 换卷/重新生成：重置作答与判分状态（answers 按题目数初始化——空数组无法记录作答） */
  useEffect(() => {
    setAnswers(questions.map(() => null));
    setSubmitted(false);
    setGrade(null);
    setSelfChecks({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId]);

  /* 生成任务轮询（组件卸载/换任务时清理定时器） */
  useEffect(() => {
    if (!genJobId) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const { job } = await api<{ job: { status: string; progress: number; message: string | null } }>(`/api/jobs/${genJobId}`);
        if (stopped) return;
        setGenStatus(job);
        if (job.status === 'succeeded' || job.status === 'failed') {
          clearInterval(timer);
          setGenJobId(null);
          void qc.invalidateQueries({ queryKey: ['quiz', materialId] });
        }
      } catch {
        /* 轮询失败继续 */
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [genJobId, materialId, qc]);

  /* 生成新测验 */
  const generate = useMutation({
    mutationFn: () => api<{ jobId: string }>(`/api/materials/${materialId}/quiz`, { method: 'POST' }),
    onSuccess: (r) => {
      setGenJobId(r.jobId);
      setGenStatus({ status: 'queued', progress: 0, message: '出题排队中…' });
    },
  });

  /* 交卷 */
  const submit = useMutation({
    mutationFn: () =>
      api<{ results: GradeResult[]; correctCount: number; total: number }>(
        `/api/materials/${materialId}/quiz/attempt`,
        { method: 'POST', body: JSON.stringify({ artifactId: quizQuery.data!.quiz!.artifactId, answers }) }
      ),
    onSuccess: (r) => {
      setGrade(r);
      setSubmitted(true);
      void qc.invalidateQueries({ queryKey: ['quiz', materialId] });
    },
  });

  /* 问答自评回写（两段式：交卷见参考答案后再评） */
  const selfCheck = useMutation({
    mutationFn: (v: { attemptId: number; correct: boolean }) =>
      api<{ ok: boolean }>(`/api/materials/${materialId}/quiz/self-check`, {
        method: 'POST',
        body: JSON.stringify(v),
      }),
    onSuccess: (_r, v) => {
      setSelfChecks((prev) => ({ ...prev, [v.attemptId]: v.correct }));
      setGrade((prev) =>
        prev
          ? {
              ...prev,
              correctCount: prev.correctCount + (v.correct ? 1 : 0),
              results: prev.results.map((x) => (x.attemptId === v.attemptId ? { ...x, correct: v.correct } : x)),
            }
          : prev
      );
      void qc.invalidateQueries({ queryKey: ['quiz', materialId] });
    },
  });

  /* 错题列表 */
  const wrong = useQuery({
    queryKey: ['quiz-wrong', materialId],
    queryFn: () => api<{ wrong: WrongDTO[] }>(`/api/materials/${materialId}/quiz/attempt`),
    enabled: showWrong,
  });

  const generating = genJobId !== null;

  /* —— 渲染 —— */

  if (quizQuery.isLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">装载中…</div>;
  }

  /* 无测验 / 生成中 */
  if (!quizQuery.data?.quiz) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <span className="material-symbols-outlined text-4xl text-ochre">quiz</span>
        <p className="font-serif text-lg">尚未出题</p>
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          AI 将基于本材料的句段命制 5 道题：2 选择 · 2 填空 · 1 问答（需在设置页配置 LLM 档案）
        </p>
        {generating ? (
          <div className="w-full max-w-sm rounded-md border bg-card p-4">
            <p className="text-xs">{genStatus?.message ?? '出题中…'}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(5, (genStatus?.progress ?? 0) * 100)}%` }} />
            </div>
            {genStatus?.status === 'failed' && <p className="mt-2 text-xs text-destructive">出题失败，可重试</p>}
          </div>
        ) : (
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="rounded-md bg-primary px-6 py-2.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            {generate.isPending ? '提交中…' : genStatus?.status === 'failed' ? '重新生成' : '生成测验'}
          </button>
        )}
      </div>
    );
  }

  const data = quizQuery.data.quiz.data;

  return (
    /* 测验容器 */
    <div className="flex flex-col gap-4 py-4">
      {/* 卷头：标题 + 重新生成 + 错题入口 */}
      <header className="flex items-center gap-2">
        <h3 className="font-serif text-lg">{data.title}</h3>
        <span className="text-xs text-ochre">{quizQuery.data.quiz.provider ?? ''}</span>
        <button
          onClick={() => {
            if (!generating && confirm('重新生成将替换当前测验（作答记录保留），确定？')) generate.mutate();
          }}
          disabled={generating}
          className="deckle ml-auto rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
        >
          {generating ? '出题中…' : '重新出题'}
        </button>
        <button onClick={() => setShowWrong((v) => !v)} className="deckle rounded-md border px-2.5 py-1 text-xs">
          错题 {quizQuery.data.wrongCount}
        </button>
      </header>

      {/* 成绩条（交卷后；问答自评会实时更新） */}
      {grade && (
        <div className={`rounded-md p-3 text-sm ${grade.correctCount === grade.total ? 'bg-secondary/10 text-secondary' : 'bg-primary/5 text-primary'}`}>
          成绩：{grade.correctCount} / {grade.total}
          {grade.correctCount === grade.total ? ' · 全对！' : '（错题已入错题本，可回顾重练）'}
        </div>
      )}

      {/* 题目列表 */}
      {data.questions.map((q, qi) => {
        const result = grade?.results[qi];
        const qaChecked = result ? selfChecks[result.attemptId] : undefined;
        return (
          <article key={qi} className="deckle rounded-md border bg-card p-4">
            <p className="mb-3 font-serif text-base leading-relaxed">
              <span className="mr-2 text-ochre">Q{qi + 1}</span>
              {q.type === 'choice' ? q.stem : q.type === 'cloze' ? q.sentence : q.question}
            </p>

            {/* 选择题 */}
            {q.type === 'choice' &&
              q.options.map((opt, oi) => {
                const picked = answers[qi] === oi;
                const right = submitted && oi === q.answer;
                const wrongPick = submitted && picked && oi !== q.answer;
                return (
                  <button
                    key={oi}
                    disabled={submitted}
                    onClick={() => setAnswers((prev) => prev.map((v, i) => (i === qi ? oi : v)))}
                    className={`mb-1.5 block w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      right
                        ? 'border-secondary bg-secondary/10 text-secondary'
                        : wrongPick
                          ? 'border-destructive bg-destructive/5 text-destructive'
                          : picked
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:bg-accent'
                    }`}
                  >
                    {String.fromCharCode(65 + oi)}. {opt}
                  </button>
                );
              })}

            {/* 填空题 */}
            {q.type === 'cloze' && !submitted && (
              <>
                {q.hint && <p className="mb-2 text-xs text-ochre">提示：{q.hint}</p>}
                <input
                  value={(answers[qi] as string) ?? ''}
                  onChange={(e) => setAnswers((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
                  placeholder="填入挖掉的词…"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </>
            )}

            {/* 问答题：作答输入 */}
            {q.type === 'qa' && !submitted && (
              <textarea
                value={(answers[qi] as string) ?? ''}
                onChange={(e) => setAnswers((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
                placeholder="用自己的话回答…"
                className="min-h-20 w-full rounded-md border border-input bg-background p-2.5 text-sm"
              />
            )}

            {/* 问答题：交卷后 = 参考答案 + 两段式自评 */}
            {q.type === 'qa' && submitted && (
              <div className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="text-xs text-muted-foreground">你的回答</p>
                <p className="mt-1">{(answers[qi] as string) || '（未作答）'}</p>
                <p className="mt-2 text-xs text-muted-foreground">参考答案</p>
                <p className="mt-1 font-serif">{q.referenceAnswer}</p>
                {qaChecked === undefined ? (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">对照后自评：</span>
                    <button
                      onClick={() => result && selfCheck.mutate({ attemptId: result.attemptId, correct: true })}
                      className="rounded bg-secondary px-3 py-1 text-xs text-secondary-foreground"
                    >
                      我掌握了
                    </button>
                    <button
                      onClick={() => result && selfCheck.mutate({ attemptId: result.attemptId, correct: false })}
                      className="rounded border border-border px-3 py-1 text-xs"
                    >
                      还没掌握
                    </button>
                  </div>
                ) : (
                  <p className={`mt-3 text-xs ${qaChecked ? 'text-secondary' : 'text-destructive'}`}>
                    {qaChecked ? '✓ 已自评掌握' : '未掌握 —— 已记入错题本'}
                  </p>
                )}
              </div>
            )}

            {/* 解析（交卷后；qa 的解析随参考答案展示） */}
            {submitted && q.type !== 'qa' && (
              <div className="mt-3 border-t border-border pt-2 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">解析：</span>
                {q.explanation}
                {q.type === 'cloze' && <span className="ml-1 text-secondary">答案：{q.answer}</span>}
              </div>
            )}
          </article>
        );
      })}

      {/* 交卷 / 重做 */}
      {!submitted ? (
        <button
          onClick={() => submit.mutate()}
          disabled={submit.isPending || answers.every((a) => a === null || a === '')}
          className="rounded-md bg-primary py-3 text-sm text-primary-foreground disabled:opacity-40"
        >
          {submit.isPending ? '判分中…' : '交卷（问答题交卷后对照参考答案自评）'}
        </button>
      ) : (
        <button
          onClick={() => {
            setSubmitted(false);
            setGrade(null);
            setSelfChecks({});
            setAnswers(data.questions.map(() => null));
          }}
          className="deckle rounded-md border py-3 text-sm"
        >
          重做本卷
        </button>
      )}

      {/* 错题回顾面板 */}
      {showWrong && (
        <section className="deckle rounded-md border bg-card p-4">
          <h4 className="mb-3 text-sm font-medium">错题回顾</h4>
          {wrong.isLoading ? (
            <p className="text-xs text-muted-foreground">装载中…</p>
          ) : (wrong.data?.wrong ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">没有错题，保持！</p>
          ) : (
            <div className="flex flex-col gap-2">
              {(wrong.data?.wrong ?? []).map((w) => (
                <div key={w.id} className="rounded-md bg-muted/40 p-3 text-xs">
                  <p className="font-medium">
                    <span className="mr-1 text-ochre">[{w.type === 'choice' ? '选择' : w.type === 'cloze' ? '填空' : '问答'}]</span>
                    {w.question.type === 'choice' ? w.question.stem : w.question.type === 'cloze' ? w.question.sentence : w.question.question}
                  </p>
                  {w.userAnswer && w.userAnswer !== 'self-ok' && (
                    <p className="mt-1 text-destructive">你的作答：{w.userAnswer}</p>
                  )}
                  <p className="mt-1 text-secondary">
                    正确答案：
                    {w.question.type === 'choice'
                      ? w.question.options[w.question.answer]
                      : w.question.type === 'cloze'
                        ? w.question.answer
                        : w.question.referenceAnswer}
                  </p>
                  {'explanation' in w.question && w.question.explanation && (
                    <p className="mt-1 text-muted-foreground">{w.question.explanation}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
