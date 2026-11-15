/**
 * 测验领域逻辑：LLM 产物的 zod 校验 / 生成提示词 / 判分
 *
 * 对应需求 12：测验标签页含多道选择题、填空题、问答题。
 * 生成走引擎 /llm/chat（want_json）→ 本模块 zod 严格校验 → 失败带错误重试一次。
 */

import { z } from 'zod';
import { normalizeWord } from '@pinglc/core';

/* ---------------------------------------------------------------------------
 * 题目 schema（LLM 输出契约）
 * ------------------------------------------------------------------------- */

/** 选择题 */
export const ChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  /** 题干 */
  stem: z.string().min(4),
  /** 四个选项 */
  options: z.array(z.string().min(1)).length(4),
  /** 正确选项下标 0-3 */
  answer: z.number().int().min(0).max(3),
  /** 解析 */
  explanation: z.string().min(1),
});

/** 填空题（原句挖空） */
export const ClozeQuestionSchema = z.object({
  type: z.literal('cloze'),
  /** 挖空后的句子（用 ___ 表示空） */
  sentence: z.string().min(8),
  /** 正确答案（一个词） */
  answer: z.string().min(1),
  /** 中文提示 */
  hint: z.string().optional(),
  explanation: z.string().min(1),
});

/** 问答题（对照参考答案自评） */
export const QAQuestionSchema = z.object({
  type: z.literal('qa'),
  question: z.string().min(4),
  /** 参考答案 */
  referenceAnswer: z.string().min(1),
  explanation: z.string().optional(),
});

export const QuestionSchema = z.discriminatedUnion('type', [
  ChoiceQuestionSchema,
  ClozeQuestionSchema,
  QAQuestionSchema,
]);

export const QuizSchema = z.object({
  title: z.string().min(2),
  questions: z.array(QuestionSchema).min(3).max(10),
});

export type Quiz = z.infer<typeof QuizSchema>;
export type QuizQuestion = z.infer<typeof QuestionSchema>;

/* ---------------------------------------------------------------------------
 * 生成提示词
 * ------------------------------------------------------------------------- */

/** 出题系统提示（结构化 JSON 契约在 user 提示中给出） */
export const QUIZ_SYSTEM =
  '你是一位资深英语命题老师。基于用户提供的原文材料命制测验题，' +
  '输出严格合法的 JSON（不要任何解释或代码围栏）。';

/**
 * 构造出题 user 提示
 * @param title 材料标题
 * @param sentences 采样句段（双语）
 */
export function buildQuizPrompt(title: string, sentences: Array<{ textEn: string; textZh: string | null }>): string {
  const material = sentences
    .map((s) => `- ${s.textEn}${s.textZh ? `\n  （译：${s.textZh}）` : ''}`)
    .join('\n');
  return `材料标题：${title}

原文句段（选段）：
${material}

请命制 5 道题：2 道选择题（choice，考词汇/理解，四选项一正确）、2 道填空题（cloze，取原文原句挖掉一个关键词，用 ___ 占位）、1 道问答题（qa，考理解与表达）。

输出 JSON 结构：
{
  "title": "测验标题",
  "questions": [
    {"type": "choice", "stem": "题干", "options": ["A","B","C","D"], "answer": 0, "explanation": "解析"},
    {"type": "cloze", "sentence": "原句（含 ___）", "answer": "挖掉的词", "hint": "中文提示", "explanation": "解析"},
    {"type": "qa", "question": "问题", "referenceAnswer": "参考答案", "explanation": "解析"}
  ]
}
要求：题目必须基于上述原文；answer 是 options 的下标；填空答案必须是原句中出现的确切单词。`;
}

/* ---------------------------------------------------------------------------
 * 判分（choice/cloze 确定性判定；qa 由用户自评）
 * ------------------------------------------------------------------------- */

/** 单题作答形态 */
export type QuizAnswer = number | string | null;

/**
 * 判定单题作答
 * @param question 题目
 * @param answer   用户作答（choice=下标；cloze=文本；qa=文本/自评由调用方处理）
 * @returns 是否正确（qa 恒 false 由自评覆盖；此处只做确定性判定）
 */
export function gradeAnswer(question: QuizQuestion, answer: QuizAnswer): boolean {
  if (question.type === 'choice') {
    return typeof answer === 'number' && answer === question.answer;
  }
  if (question.type === 'cloze') {
    if (typeof answer !== 'string') return false;
    // 归一化比较（大小写/撇号宽容；标点由提取剥离）
    return normalizeWord(answer) === normalizeWord(question.answer);
  }
  return false; // qa：自评（前端「我会了/没掌握」按钮写入）
}

/**
 * zod 校验失败 → 给 LLM 的修复提示（修复重试环）
 * @param issues zod 错误列表
 */
export function repairPrompt(issues: z.ZodIssue[]): string {
  const detail = issues
    .slice(0, 5)
    .map((i) => `路径 ${i.path.join('.')}: ${i.message}`)
    .join('；');
  return `你上一条输出未通过结构校验（${detail}）。请严格按要求的 JSON 结构重新输出，不要任何解释。`;
}
