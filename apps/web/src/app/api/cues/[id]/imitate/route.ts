/**
 * 情景实战仿写点评 API（需求 17 玩法六：以原文为示例逐句指导创作）
 * POST /api/cues/[id]/imitate  Body: { userText } → { feedback(Markdown) }
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues } from '@/lib/db/schema';
import { EngineError, enginePost } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile } from '@/lib/server/providers';

export const runtime = 'nodejs';

/** 仿写点评系统提示 */
const IMITATE_SYSTEM =
  '你是英语写作教练。用户给你一个英文「示例句」和ta基于自己实际情况仿写的句子。' +
  '用中文点评：1) 肯定结构复用对的地方；2) 指出语法/用词问题并给修正；3) 给一个更地道的改写建议。' +
  'Markdown 输出，精炼（200 字内）。';

/**
 * POST —— 点评仿写
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { userText?: string };
  const userText = body.userText?.trim();
  if (!userText) return NextResponse.json({ error: '仿写内容为空' }, { status: 400 });

  const db = getDb();
  const cue = db.select().from(cues).where(eq(cues.id, Number(id))).all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });

  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    return NextResponse.json({ error: '未配置 LLM 档案（设置页添加）' }, { status: 400 });
  }
  try {
    const { content } = await enginePost<{ content: string | null }>('/llm/chat', {
      profile: toEngineProfile(profile),
      system: IMITATE_SYSTEM,
      user: `示例原句：${cue.textEn}\n中文参考：${cue.textZh ?? '（无）'}\n\n我的仿写：${userText}`,
      temperature: 0.4,
    });
    return NextResponse.json({ feedback: content ?? '' });
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '点评失败';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
