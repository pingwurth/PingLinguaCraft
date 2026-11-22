/**
 * 研习手册聚合 API（设计稿 _7 研习手册 Manual）
 * GET /api/words/[id]/manual —— 单词全息档案：词条（音标/状态/笔记）+ SRS 轮转 +
 * 原典语境（收录句段双语 + 材料标题），一次请求供手册页头部与语境卡渲染。
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues, materials, srsCards, words } from '@/lib/db/schema';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET —— 单词研习手册聚合数据
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();

  // 词条字段（音标在 words 行上；只取客户端契约声明的字段，未消费的
  // originMaterialId/lastReviewedAt 不随聚合下发，防响应与页面契约静默漂移）
  const word = db
    .select({
      id: words.id,
      lemma: words.lemma,
      displayForm: words.displayForm,
      phoneticUk: words.phoneticUk,
      phoneticUs: words.phoneticUs,
      status: words.status,
      noteMd: words.noteMd,
      originCueId: words.originCueId,
    })
    .from(words)
    .where(eq(words.id, wordId))
    .all()[0];
  if (!word) return NextResponse.json({ error: '单词不存在' }, { status: 404 });

  // SRS 轮转卡（FSRS：复习次数 / 稳定性 / 下次到期；difficulty 客户端未渲染不下发）
  const srs = db
    .select({
      reps: srsCards.reps,
      stability: srsCards.stability,
      dueMs: srsCards.dueMs,
    })
    .from(srsCards)
    .where(eq(srsCards.itemId, wordId))
    .all()[0] ?? null;

  // 原典语境：收录句段（双语 + 起止时间）+ 所属材料标题（去原声入口用）
  let cue: {
    id: number;
    textEn: string;
    textZh: string | null;
    startMs: number;
    endMs: number;
    materialId: number;
    materialTitle: string;
  } | null = null;
  if (word.originCueId !== null) {
    const row = db
      .select({
        id: cues.id,
        textEn: cues.textEn,
        textZh: cues.textZh,
        startMs: cues.startMs,
        endMs: cues.endMs,
        materialId: cues.materialId,
        materialTitle: materials.title,
      })
      .from(cues)
      .leftJoin(materials, eq(materials.id, cues.materialId))
      .where(eq(cues.id, word.originCueId))
      .all()[0];
    if (row) {
      cue = {
        id: row.id,
        textEn: row.textEn,
        textZh: row.textZh,
        startMs: row.startMs,
        endMs: row.endMs,
        materialId: row.materialId,
        materialTitle: row.materialTitle ?? '（材料已移除）',
      };
    }
  }

  return NextResponse.json({ word, srs, cue });
}
