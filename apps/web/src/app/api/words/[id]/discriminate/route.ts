/**
 * 辨析矩阵 API（研习手册，设计稿 _7 文人辨析矩阵）
 * POST /api/words/[id]/discriminate —— 生成任务（幂等：已有且未 force 则直接返回）
 * GET  /api/words/[id]/discriminate —— 最新辨析矩阵（近义词侧重对比）
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiArtifacts, words } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { DiscriminateSchema, type Discriminate } from '@/lib/manualCard';
import { parseIdParam, readJsonBody } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * contentMd → 合规辨析矩阵（语法解析 + schema 形状校验双重把关）
 * @param contentMd ai_artifacts.contentMd 原值（共享自由文本列，可空/坏行）
 * @returns 合规矩阵；空/截断/手改/形状不合一律 null（调用方按「尚未生成」处理）
 */
function parseDiscriminate(contentMd: string | null | undefined): Discriminate | null {
  if (!contentMd) return null;
  try {
    const parsed = DiscriminateSchema.safeParse(JSON.parse(contentMd));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * POST —— 发起辨析矩阵生成
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  // readJsonBody 统一体检：null/数组/原始值/畸形 JSON 一律 400（裸 request.json
  // 对字面 null body 会解析成功，后续 body.force 读取抛 TypeError → 500）
  const body = await readJsonBody<{ force?: boolean }>(request);
  if (body === null) return NextResponse.json({ error: '请求体非法' }, { status: 400 });
  // force 显式收窄布尔：readJsonBody 只保证对象形态，字符串真值（如 "false"）
  // 会按 truthiness 绕过幂等短路强制重生成
  const force = body.force === true;
  const db = getDb();
  // userId=1 归属过滤：全库预留 user_id 列的统一约定
  const word = db
    .select({ id: words.id })
    .from(words)
    .where(and(eq(words.id, wordId), eq(words.userId, 1)))
    .all()[0];
  if (!word) return NextResponse.json({ error: '单词不存在' }, { status: 404 });

  // 幂等：已有「可解析且形状合规」的矩阵且未要求 force → 直接返回已有。
  // 只查行存在会把坏行（截断/手改）也当已有——GET 侧按空态展示、POST 侧
  // 永远回 cached:true，用户陷入无法重新生成的死胡同；故幂等判定与 GET
  // 同口径（schema 校验通过才算已有）
  if (!force) {
    const exist = db
      .select({ contentMd: aiArtifacts.contentMd })
      .from(aiArtifacts)
      .where(
        and(
          eq(aiArtifacts.kind, 'discriminate'),
          eq(aiArtifacts.subjectType, 'word'),
          eq(aiArtifacts.subjectId, wordId),
          eq(aiArtifacts.userId, 1)
        )
      )
      .orderBy(desc(aiArtifacts.createdAt))
      .limit(1)
      .all()[0];
    if (parseDiscriminate(exist?.contentMd)) return NextResponse.json({ cached: true });
  }

  const jobId = createJob({ type: 'discriminate', payload: { wordId } });
  startPipeline(jobId);
  return NextResponse.json({ jobId }, { status: 202 });
}

/**
 * GET —— 最新辨析矩阵
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wordId = parseIdParam(id);
  if (wordId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const db = getDb();
  const row = db
    .select({ contentMd: aiArtifacts.contentMd })
    .from(aiArtifacts)
    .where(
      and(
        eq(aiArtifacts.kind, 'discriminate'),
        eq(aiArtifacts.subjectType, 'word'),
        eq(aiArtifacts.subjectId, wordId),
        eq(aiArtifacts.userId, 1)
      )
    )
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1)
    .all()[0];
  // contentMd 是共享自由文本列，坏行（截断/手改/形状不合）按「尚未生成」空态
  // 处理而非 500/渲染崩溃（parseDiscriminate 与 POST 幂等同口径）
  return NextResponse.json({ matrix: parseDiscriminate(row?.contentMd) });
}
