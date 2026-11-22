/**
 * 研习手册领域逻辑（设计稿 _7 研习手册 Manual：辨析矩阵 + 仿写点拨）
 *
 * 辨析矩阵：LLM 产出目标词与 1~3 个近义词的侧重对比（落 ai_artifacts，
 * kind='discriminate'，经 jobs 管线异步生成，与深学卡同构）。
 * 仿写点拨：用户提交仿写短句后的即时结构化批改（同步路由调用，不落库）。
 */

import { z } from 'zod';

/** 辨析矩阵 schema（近义词侧重对比） */
export const DiscriminateSchema = z.object({
  /** 一句意象总评（如「心如天平 · 从容权度」） */
  summary: z.string().min(2),
  /** 近义对比词（含目标词自身，每词侧重一句话 + 阐述） */
  rivals: z
    .array(
      z.object({
        word: z.string().min(1),
        /** 侧重（如「侧重从容深思」） */
        focus: z.string().min(2),
        /** 阐述（语境与语域说明） */
        nuance: z.string().min(2),
      })
    )
    .min(1)
    .max(4),
});

/** 辨析矩阵数据形态 */
export type Discriminate = z.infer<typeof DiscriminateSchema>;

/** 辨析矩阵生成系统提示 */
export const DISCRIMINATE_SYSTEM =
  '你是英语词汇语义学家。基于给定单词（及其语境例句）挑选 1~3 个最易混淆的近义词，' +
  '输出 JSON：{"summary":"一句中文意象总评","rivals":[{"word":"词","focus":"侧重……","nuance":"阐述……"}]}' +
  'rivals 必须包含目标词自身（与其他近义词并列对比）；中文撰写；只输出 JSON。';

/**
 * 构造辨析矩阵 user 提示
 * @param word 单词
 * @param example 语境例句（可空）
 */
export function buildDiscriminatePrompt(word: string, example: string | null): string {
  return `单词：${word}\n语境例句：${example ?? '（无）'}\n\n请给出该词与近义词的辨析矩阵。`;
}

/** 仿写点拨 schema（同步批改，不落库） */
export const WriteCheckSchema = z.object({
  /** 总评（一两句） */
  overall: z.string().min(2),
  /** 逐条点评（good=亮点 / issue=待改） */
  points: z
    .array(
      z.object({
        kind: z.enum(['good', 'issue']),
        text: z.string().min(1),
      })
    )
    .max(5),
  /** 高阶搭配建议（含目标词的地道搭配） */
  collocations: z.array(z.string().min(2)).max(5),
});

/** 仿写点拨数据形态 */
export type WriteCheck = z.infer<typeof WriteCheckSchema>;

/** 仿写点拨系统提示 */
export const WRITE_CHECK_SYSTEM =
  '你是英语写作教练。用户围绕指定单词写了一句仿写，请输出 JSON：' +
  '{"overall":"中文总评一两句","points":[{"kind":"good"或"issue","text":"中文点评"}],' +
  '"collocations":["含该词的地道搭配"]}' +
  '点评具体到用词语法，不空泛；collocations 2~4 条；只输出 JSON。';

/**
 * 构造仿写点拨 user 提示
 * @param word 目标单词
 * @param framesHint 仿写构架提示（可空）
 * @param text 用户仿写短句
 */
export function buildWriteCheckPrompt(word: string, framesHint: string | null, text: string): string {
  return `目标单词：${word}\n仿写构架参考：${framesHint ?? '（无）'}\n用户仿写：${text}\n\n请点评并给搭配建议。`;
}
