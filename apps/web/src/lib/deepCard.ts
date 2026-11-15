/**
 * 深学卡领域逻辑（M4：词源拓扑 + 仿写构架，设计稿 _6 词源溯流 / ai_2 深学卡）
 *
 * 一次 LLM 调用产出两部分：词源树（JSON，前端渲染拓扑）+ 仿写构架（句型模板）。
 * zod 严格校验；校验失败的修复提示词与测验共用 quiz.ts 的 repairPrompt
 * （调用-校验-修复循环在 pipeline.ts 的 structuredLLM 单点实现）。
 */

import { z } from 'zod';

/** 词源树 schema */
export const EtymologySchema = z.object({
  /** 词源一句话概述 */
  origin: z.string().min(2),
  /** 构词成分（词根/词缀） */
  roots: z
    .array(
      z.object({
        part: z.string().min(1),
        meaning: z.string().min(1),
        /** 来源语言（拉丁/希腊/古英语…） */
        lang: z.string().optional(),
      })
    )
    .max(6),
  /** 同源词（构词拓扑的兄弟节点） */
  related: z
    .array(
      z.object({
        word: z.string().min(1),
        relation: z.string().min(1),
      })
    )
    .max(6),
});

/** 仿写构架 schema */
export const FramesSchema = z.object({
  frames: z
    .array(
      z.object({
        /** 句型模板（含 ___ 占位） */
        pattern: z.string().min(4),
        /** 使用要点 */
        tip: z.string().optional(),
      })
    )
    .min(1)
    .max(4),
});

export const DeepCardSchema = z.intersection(EtymologySchema, FramesSchema);

export type DeepCard = z.infer<typeof DeepCardSchema>;

/** 深学生成系统提示 */
export const DEEP_SYSTEM =
  '你是英语词汇词源学家与写作教练。基于给定单词（及其语境例句）输出 JSON：' +
  '{"origin":"词源一句话","roots":[{"part":"成分","meaning":"含义","lang":"来源语言"}],' +
  '"related":[{"word":"同源词","relation":"关系说明"}],' +
  '"frames":[{"pattern":"含___的仿写句型模板","tip":"使用要点"}]}' +
  '中文撰写；roots 最多 6 条；related 最多 6 条；frames 2-3 条。只输出 JSON。';

/**
 * 构造深学 user 提示
 * @param word 单词
 * @param example 语境例句（可空）
 */
export function buildDeepPrompt(word: string, example: string | null): string {
  return `单词：${word}\n语境例句：${example ?? '（无）'}\n\n请给出词源树与仿写构架。`;
}
