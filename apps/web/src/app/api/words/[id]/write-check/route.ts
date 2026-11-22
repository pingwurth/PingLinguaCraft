/**
 * 仿写点拨 API（研习手册，设计稿 _7 文人仿写演练场）
 * POST /api/words/[id]/write-check  Body: { text }
 * —— 同步 LLM 结构化批改（总评 / 逐条点评 / 搭配建议），即时交互不落库；
 *    词源仿写构架（deep 数据）作为提示参考一并送入。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, cues, words } from '@/lib/db/schema';
import { parseIdParam, readJsonBody } from '@/lib/server/params';
import { EngineError, engineErrorResponse } from '@/lib/server/engine';
import { structuredLLM } from '@/lib/server/structuredLlm';
import { WRITE_CHECK_SYSTEM, buildWriteCheckPrompt, WriteCheckSchema } from '@/lib/manualCard';
import { WRITE_TEXT_MAX } from '@/lib/limits';

export const runtime = 'nodejs';

/** 仿写短句长度上限（manualCard 单源：超长直接 400 拒绝而非静默截断——截断
 *  会让批改与用户实际所写不符；客户端 textarea 同上限 maxLength 正常路径不触达） */
const TEXT_MAX = WRITE_TEXT_MAX;

/**
 * POST —— 仿写即时点拨
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = await readJsonBody<{ text?: unknown }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  // readJsonBody 只保证 body 是对象，text 字段类型仍需显式守卫（{"text":123}
  // 会让 123?.trim 抛 TypeError → 框架 500）
  if (typeof body.text !== 'string') return NextResponse.json({ error: 'text 必须是字符串' }, { status: 400 });
  const text = body.text.trim();
  if (!text) return NextResponse.json({ error: '仿写内容为空' }, { status: 400 });
  if (text.length > TEXT_MAX) {
    return NextResponse.json({ error: `仿写内容超长（上限 ${TEXT_MAX} 字）` }, { status: 400 });
  }

  const db = getDb();
  // 词条 + 原典例句（批改语境）
  const word = db
    .select({ displayForm: words.displayForm, originCueId: words.originCueId })
    .from(words)
    .where(eq(words.id, wordId))
    .all()[0];
  if (!word) return NextResponse.json({ error: '单词不存在' }, { status: 404 });
  const example = word.originCueId
    ? db.select({ textEn: cues.textEn }).from(cues).where(eq(cues.id, word.originCueId)).all()[0]?.textEn ?? null
    : null;

  // 仿写构架（深学卡 imitation 产物）作为参考提示
  const frameRow = db
    .select({ contentMd: aiArtifacts.contentMd })
    .from(aiArtifacts)
    .where(and(eq(aiArtifacts.kind, 'imitation'), eq(aiArtifacts.subjectType, 'word'), eq(aiArtifacts.subjectId, wordId)))
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1)
    .all()[0];
  let framesHint: string | null = null;
  if (frameRow?.contentMd) {
    try {
      const frames = JSON.parse(frameRow.contentMd) as Array<{ pattern: string }>;
      framesHint = frames.map((f) => f.pattern).join('；');
    } catch {
      framesHint = null;
    }
  }

  // 同步结构化生成（structuredLLM 单源：管线与同步路由共用同一套
  // 「生成 → 校验 → 修复重试」回路，温度/重试/错误映射不再各持一份）；
  // 引擎未启动/超时/非 2xx/两次不合规抛 EngineError，映射为可读错误响应
  // 而非框架级 500（与 shadow-score 等引擎代理路由同款出口）
  try {
    const { data } = await structuredLLM({
      schema: WriteCheckSchema,
      system: WRITE_CHECK_SYSTEM,
      user: buildWriteCheckPrompt(word.displayForm, framesHint, example, text),
      label: '点拨',
    });
    return NextResponse.json({ check: data });
  } catch (err) {
    /* 「未配置 LLM 档案」守卫只在 structuredLLM 一处（此前路由预检重复同一
       判定与文案，改一处漏一处）；EngineError status=0 映射 400，其余 502 */
    if (err instanceof EngineError && err.status === 0) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return engineErrorResponse(err, '点拨生成失败');
  }
}
