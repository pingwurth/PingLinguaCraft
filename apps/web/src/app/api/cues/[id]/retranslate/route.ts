/**
 * 单句重译 API（同步，需求 9：单句重新翻译、中英互译）
 * POST /api/cues/[id]/retranslate  Body: { direction?: 'en2zh'|'zh2en', profileId? }
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues } from '@/lib/db/schema';
import { enginePost, EngineError } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile } from '@/lib/server/providers';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * POST —— 单句重译（30s 级同步调用；方向可中→英）
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as {
    direction?: 'en2zh' | 'zh2en';
    profileId?: number;
  };
  const direction = body.direction ?? 'en2zh';
  const db = getDb();
  const cue = db.select().from(cues).where(eq(cues.id, pid)).all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });

  const sourceText = direction === 'en2zh' ? cue.textEn : (cue.textZh ?? '');
  if (!sourceText.trim()) {
    return NextResponse.json({ error: direction === 'zh2en' ? '该句暂无中文译文' : '原文为空' }, { status: 400 });
  }

  const profile = resolveProfile('translate', body.profileId);
  if (!profile || profile.kind !== 'cloud') {
    return NextResponse.json({ error: '未配置翻译档案（请在设置页添加）' }, { status: 400 });
  }
  try {
    const { translations } = await enginePost<{ translations: string[] }>('/translate', {
      texts: [sourceText],
      profile: toEngineProfile(profile),
      direction,
    });
    const translated = translations[0] ?? '';
    const now = new Date();
    if (direction === 'en2zh') {
      db.update(cues)
        .set({ textZh: translated, translationProvider: profile.name, isEdited: true, updatedAt: now })
        .where(eq(cues.id, cue.id))
        .run();
    } else {
      // 中→英：写回原文（并清词级时间戳——旧 words 已失配）
      db.update(cues)
        .set({ textEn: translated, wordsJson: null, translationProvider: profile.name, isEdited: true, updatedAt: now })
        .where(eq(cues.id, cue.id))
        .run();
    }
    return NextResponse.json({ ok: true, text: translated });
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '翻译失败';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
