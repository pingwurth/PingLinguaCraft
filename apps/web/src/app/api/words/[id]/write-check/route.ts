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
import { resolveProfile, toEngineProfile } from '@/lib/server/providers';
import { enginePost } from '@/lib/server/engine';
import { repairPrompt } from '@/lib/quiz';
import { WRITE_CHECK_SYSTEM, buildWriteCheckPrompt, WriteCheckSchema } from '@/lib/manualCard';

export const runtime = 'nodejs';

/** 仿写短句长度上限（超长截断，防 token 失控） */
const TEXT_MAX = 600;

/**
 * POST —— 仿写即时点拨
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = await readJsonBody<{ text?: string }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  const text = body.text?.trim().slice(0, TEXT_MAX);
  if (!text) return NextResponse.json({ error: '仿写内容为空' }, { status: 400 });

  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    return NextResponse.json({ error: '未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）' }, { status: 400 });
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

  // 同步结构化生成（want_json；zod 校验失败带错误修复重试一次，与管线
  // structuredLLM 同款策略——批改 JSON 偶发不合规，一次往返的失败率不可接受）
  const user = buildWriteCheckPrompt(word.displayForm, framesHint, `${text}\n原典例句参考：${example ?? '（无）'}`);
  let r = await enginePost<{ json: unknown }>('/llm/chat', {
    profile: toEngineProfile(profile),
    system: WRITE_CHECK_SYSTEM,
    user,
    want_json: true,
    temperature: 0.3,
  });
  let parsed = WriteCheckSchema.safeParse(r.json);
  if (!parsed.success) {
    r = await enginePost<{ json: unknown }>('/llm/chat', {
      profile: toEngineProfile(profile),
      system: WRITE_CHECK_SYSTEM,
      user: `${user}\n\n${repairPrompt(parsed.error.issues)}`,
      want_json: true,
      temperature: 0.2,
    });
    parsed = WriteCheckSchema.safeParse(r.json);
  }
  if (!parsed.success) {
    return NextResponse.json({ error: '点拨生成异常，请重试' }, { status: 502 });
  }
  return NextResponse.json({ check: parsed.data });
}
