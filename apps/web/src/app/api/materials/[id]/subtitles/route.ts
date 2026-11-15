/**
 * 字幕导入/导出 API（需求 9）
 * GET  /api/materials/[id]/subtitles?format=srt|vtt&mode=en|zh|bilingual —— 导出
 * POST /api/materials/[id]/subtitles —— 导入（替换全部句段，body 为字幕文本）
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { serializeSrt, serializeVtt, type Cue } from '@pinglc/core';
import { getDb } from '@/lib/db';
import { cues as cuesTable, materials } from '@/lib/db/schema';
import { createJob, startPipeline } from '@/lib/jobs/pipeline';
import { uniqueWordCount } from '@pinglc/core';
import { parseIdParam } from '@/lib/server/params';

export const runtime = 'nodejs';

/**
 * GET —— 导出字幕文本（纯文本响应，Content-Disposition 触发下载）
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pid = parseIdParam(id);
  if (pid === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const url = new URL(request.url);
  // 白名单校验：format 直接拼进 Content-Disposition 文件名（注入面），mode
  // 决定双语序列化——非法值 400 而非产出错误扩展名的文件
  const formatRaw = url.searchParams.get('format') ?? 'srt';
  const modeRaw = url.searchParams.get('mode') ?? 'bilingual';
  if (!['srt', 'vtt'].includes(formatRaw) || !['en', 'zh', 'bilingual'].includes(modeRaw)) {
    return NextResponse.json({ error: '非法的 format/mode' }, { status: 400 });
  }
  const format = formatRaw as 'srt' | 'vtt';
  const mode = modeRaw as 'en' | 'zh' | 'bilingual';

  const db = getDb();
  const rows = db
    .select()
    .from(cuesTable)
    .where(eq(cuesTable.materialId, pid))
    .all()
    .sort((a, b) => a.index - b.index);
  if (rows.length === 0) return NextResponse.json({ error: '该材料暂无字幕' }, { status: 404 });

  const cueList: Cue[] = rows.map((r) => ({
    index: r.index,
    startMs: r.startMs,
    endMs: r.endMs,
    textEn: r.textEn,
    textZh: r.textZh,
  }));
  const text = format === 'vtt' ? serializeVtt(cueList, mode) : serializeSrt(cueList, mode);
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="material-${pid}.${format}"`,
    },
  });
}

/**
 * POST —— 导入字幕（整体替换；Body: { content, retranslate? }）
 * 有译文列的双语字幕会一并写入
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { content?: string; retranslate?: boolean };
  const content = body.content?.trim();
  if (!content) return NextResponse.json({ error: '字幕内容为空' }, { status: 400 });

  const db = getDb();
  const materialId = parseIdParam(id);
  if (materialId === null) return NextResponse.json({ error: '参数非法' }, { status: 400 });
  const material = db.select().from(materials).where(eq(materials.id, materialId)).all()[0];
  if (!material) return NextResponse.json({ error: '材料不存在' }, { status: 404 });

  const now = new Date();
  // 解析并整体替换（事务）
  const { parseSrt, parseVtt } = await import('@pinglc/core');
  const parsed = /^﻿?WEBVTT/.test(content) ? parseVtt(content) : parseSrt(content);
  if (parsed.cues.length === 0) {
    return NextResponse.json({ error: `解析出 0 条句段${parsed.errors.length ? `（${parsed.errors[0]}）` : ''}` }, { status: 422 });
  }
  db.transaction((tx) => {
    tx.delete(cuesTable).where(eq(cuesTable.materialId, materialId)).run();
    tx.insert(cuesTable)
      .values(
        parsed.cues.map((c) => ({
          userId: 1,
          materialId,
          index: c.index,
          startMs: c.startMs,
          endMs: c.endMs,
          textEn: c.textEn,
          textZh: c.textZh ?? null,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .run();
  });
  // 统计回填
  db.update(materials)
    .set({
      sentenceCount: parsed.cues.length,
      uniqueWordCount: uniqueWordCount(parsed.cues.map((c) => c.textEn).join('\n')),
      subtitleStatus: 'ready',
      updatedAt: now,
    })
    .where(eq(materials.id, materialId))
    .run();

  // 需求场景：导入的纯英文字幕需要翻译时直接挂重译管线
  if (body.retranslate && parsed.cues.every((c) => !c.textZh)) {
    const jobId = createJob({ type: 'retranslate', materialId, payload: {} });
    startPipeline(jobId);
    return NextResponse.json({ ok: true, imported: parsed.cues.length, retranslateJobId: jobId });
  }
  return NextResponse.json({ ok: true, imported: parsed.cues.length });
}
