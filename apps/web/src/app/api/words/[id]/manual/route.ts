/**
 * 研习手册聚合 API（设计稿 _7 研习手册 Manual）
 * GET /api/words/[id]/manual —— 单词全息档案：词条（音标/状态/笔记）+ SRS 轮转 +
 * 原典语境（收录句段双语 + 材料标题），一次请求供手册页头部与语境卡渲染。
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
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
    // userId=1 归属过滤：全库预留 user_id 列的统一约定（多用户化后不漏服他
    // 人词条——手册聚合含笔记/语境，属隐私面）
    .where(and(eq(words.id, wordId), eq(words.userId, 1)))
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
    .where(and(eq(srsCards.itemId, wordId), eq(srsCards.itemType, 'word'), eq(srsCards.userId, 1)))
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
      // innerJoin 与 write-check 同口径：非本人材料的语境行整行排除（leftJoin
      // 只会把标题置空，双语原句仍会下发——注释所称「语境属隐私面」要能排除行）
      .innerJoin(materials, and(eq(materials.id, cues.materialId), eq(materials.userId, 1)))
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
        // innerJoin 下材料行必然存在且 title NOT NULL，无「材料已移除」路径
        materialTitle: row.materialTitle,
      };
    }
  }

  return NextResponse.json({ word, srs, cue });
}
