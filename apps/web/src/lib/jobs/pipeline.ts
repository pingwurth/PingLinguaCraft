/**
 * 长任务管线（web 编排层核心）
 *
 * web 是编排者：DB 写入只发生在这里；引擎只做计算。
 * 管线类型（jobs.type）：
 *   import        导入主链（upload / link / text 三形态，payload.kind 区分）
 *   restt         整材料重 STT
 *   retranslate   整材料重翻译
 *   restt_cue     单句切片重 STT
 *   retranslate_cue 同步实现（不经管线）
 *   ai_analysis   句子 AI 解析（收藏）
 *   ai_note       单词 AI 笔记
 *   model_download 本地引擎模型下载（设置页「下载模型」，payload.engine）
 *
 * 可恢复性：管线幂等（cues 已存在则跳过 STT、译文存在则跳过），进程重启后
 * 由 GET /api/jobs 触发 recovery 重跑未终态任务；引擎任务重新提交即可。
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  segmentWords,
  uniqueWordCount,
  parseSrt,
  parseVtt,
  type WordTiming,
} from '@pinglc/core';
import type { z } from 'zod';
import { getDb, MEDIA_ROOT } from '@/lib/db';
import {
  cues as cuesTable,
  favorites as favoritesTable,
  jobs as jobsTable,
  materials as materialsTable,
  words as wordsTable,
  aiArtifacts,
} from '@/lib/db/schema';
import {
  EngineError,
  engineAwaitJob,
  enginePost,
  engineSubmitJob,
} from '@/lib/server/engine';
import { materialDir } from '@/lib/server/media';
import { resolveProfile, toEngineProfile, type ResolvedProfile } from '@/lib/server/providers';
import { ttsEngineFromParams } from '@/lib/providers';
import { QUIZ_SYSTEM, buildQuizPrompt, QuizSchema, repairPrompt } from '@/lib/quiz';
import { DEEP_SYSTEM, buildDeepPrompt, DeepCardSchema } from '@/lib/deepCard';

/** 在途任务注册表（进程内；重启后为空 → recovery 判定依据） */
const _inflight = new Set<string>();

/* ---------------------------------------------------------------------------
 * 任务行辅助
 * ------------------------------------------------------------------------- */

/**
 * 创建任务行
 * @param fields 任务字段（type/materialId/cueId/payload）
 * @returns 任务 id
 */
export function createJob(fields: {
  type: string;
  materialId?: number | null;
  cueId?: number | null;
  payload?: Record<string, unknown>;
}): string {
  const id = randomUUID();
  getDb()
    .insert(jobsTable)
    .values({
      id,
      userId: 1,
      type: fields.type,
      materialId: fields.materialId ?? null,
      cueId: fields.cueId ?? null,
      payloadJson: fields.payload ? JSON.stringify(fields.payload) : null,
      status: 'queued',
      createdAt: new Date(),
    })
    .run();
  return id;
}

/**
 * 更新任务行（增量）
 * @param id 任务 id
 * @param fields 待更新字段
 */
function updateJob(
  id: string,
  fields: Partial<{
    status: string;
    progress: number;
    message: string | null;
    error: string | null;
    engineJobId: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    resultJson: string | null;
  }>
): void {
  const db = getDb();
  db.update(jobsTable).set(fields).where(eq(jobsTable.id, id)).run();
}

/**
 * 启动管线（fire-and-forget；异常兜底写失败态）
 * @param jobId 任务 id
 */
export function startPipeline(jobId: string): void {
  if (_inflight.has(jobId)) return;
  _inflight.add(jobId);
  void runPipeline(jobId).finally(() => _inflight.delete(jobId));
}

/**
 * 恢复未终态任务（GET /api/jobs 时惰性触发）：不在在途表 → 重跑
 * 幂等管线保证不重复已完成步骤。
 */
export function recoverStaleJobs(): void {
  const db = getDb();
  const rows = db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(sql`${jobsTable.status} IN ('queued','running')`)
    .all();
  for (const row of rows) {
    if (!_inflight.has(row.id)) {
      updateJob(row.id, { message: '进程重启后恢复中…' });
      startPipeline(row.id);
    }
  }
}

/* ---------------------------------------------------------------------------
 * 共用子步骤
 * ------------------------------------------------------------------------- */

/** 引擎 STT 结果结构 */
interface STTResult {
  language: string;
  duration: number;
  words: WordTiming[];
}

/**
 * 执行 STT（引擎长任务）并落库为 cues
 * @param jobId 管线任务 id
 * @param mediaId 材料 id
 * @param wavPath 16kHz wav 路径
 * @param profileId STT 档案（可选）
 * @param progressRange 进度区间 [from, to]（管线上的一段）
 */
async function runSttAndSaveCues(
  jobId: string,
  materialId: number,
  wavPath: string,
  profileId: number | undefined,
  progressRange: [number, number]
): Promise<number> {
  const profile = resolveProfile('stt', profileId);
  if (!profile) throw new EngineError('无可用 STT 档案', 0);

  const [from, to] = progressRange;
  updateJob(jobId, { message: `STT 转写中（${profile.name}）…`, progress: from });

  const engineJob = await engineSubmitJob('stt', {
    audio_path: wavPath,
    profile: toEngineProfile(profile),
    language: 'en',
  });
  updateJob(jobId, { engineJobId: engineJob.id, status: 'running', startedAt: new Date() });

  const result = (await engineAwaitJob(engineJob.id, {
    onProgress: (s) => {
      updateJob(jobId, {
        progress: from + (to - from) * s.progress,
        message: s.message ?? '转写中…',
      });
    },
  })) as STTResult;

  // 词流 → 分句 → cues 落库（core 分句）
  const segmented = segmentWords(result.words ?? []);
  if (segmented.length === 0) throw new EngineError('STT 未产生有效词流', 0);

  saveCues(
    materialId,
    segmented.map((s) => ({
      index: s.index,
      startMs: s.startMs,
      endMs: s.endMs,
      textEn: s.text,
      words: s.words,
      confidence: s.words.length
        ? s.words.reduce((a, w) => a + (w.p ?? 0), 0) / s.words.length
        : null,
    }))
  );
  return segmented.length;
}

/**
 * cues 全量替换落库（事务：删旧插新）
 * @param materialId 材料 id
 * @param rows cue 行数据
 * @param provider 溯源（stt 或 subtitle import 来源）
 */
function saveCues(
  materialId: number,
  rows: Array<{
    index: number;
    startMs: number;
    endMs: number;
    textEn: string;
    textZh?: string | null;
    words?: WordTiming[];
    confidence?: number | null;
  }>
): void {
  const db = getDb();
  const now = new Date();
  db.transaction((tx) => {
    // 注意：drizzle 同步驱动的事务回调里，查询必须显式 .run()（只构建不执行是静默空操作）
    tx.delete(cuesTable).where(eq(cuesTable.materialId, materialId)).run();
    if (rows.length > 0) {
      tx.insert(cuesTable)
        .values(
          rows.map((r) => ({
            userId: 1,
            materialId,
            index: r.index,
            startMs: r.startMs,
            endMs: r.endMs,
            textEn: r.textEn,
            textZh: r.textZh ?? null,
            wordsJson: r.words ? JSON.stringify(r.words) : null,
            sttConfidence: r.confidence ?? null,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .run();
    }
  });
}

/**
 * 解析字幕文本（SRT/VTT 自动识别）→ cue 行
 * @param text 字幕全文
 */
function parseSubtitleText(text: string): Array<{ index: number; startMs: number; endMs: number; textEn: string; textZh: string | null }> {
  const looksVtt = /^﻿?WEBVTT/.test(text.trim());
  const parsed = looksVtt ? parseVtt(text) : parseSrt(text);
  if (parsed.cues.length === 0) throw new EngineError('字幕文件解析出 0 条句段', 0);
  return parsed.cues.map((c) => ({
    index: c.index,
    startMs: c.startMs,
    endMs: c.endMs,
    textEn: c.textEn,
    textZh: c.textZh ?? null,
  }));
}

/**
 * 材料翻译（批量引擎调用，逐批更新；失败句保留空译文可重试）
 * @param jobId 管线任务 id
 * @param materialId 材料 id
 * @param profileId 翻译档案（可选）
 * @param onlyMissing 仅译缺失/失败句
 * @param progressRange 进度区间
 * @returns 成功句数 / 总句数
 */
async function translateMaterial(
  jobId: string,
  materialId: number,
  profileId: number | undefined,
  onlyMissing: boolean,
  progressRange: [number, number]
): Promise<{ ok: number; total: number; skippedNoProfile?: boolean }> {
  const db = getDb();
  const rows = db
    .select()
    .from(cuesTable)
    .where(eq(cuesTable.materialId, materialId))
    .all()
    .sort((a, b) => a.index - b.index);
  const targets = onlyMissing ? rows.filter((r) => !r.textZh || r.textZh.trim() === '') : rows;
  if (targets.length === 0) return { ok: 0, total: 0 };

  const profile = resolveProfile('translate', profileId);
  if (!profile || profile.kind !== 'cloud') {
    updateJob(jobId, {
      message: '未配置翻译档案（设置页添加 hy-MT2 或云端端点）——已跳过翻译',
    });
    return { ok: 0, total: targets.length, skippedNoProfile: true };
  }

  const [from, to] = progressRange;
  const BATCH = 20;
  let ok = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    try {
      const { translations } = await enginePost<{ translations: string[] }>('/translate', {
        texts: batch.map((c) => c.textEn),
        profile: toEngineProfile(profile),
        direction: 'en2zh',
      });
      const now = new Date();
      batch.forEach((cue, j) => {
        const zh = translations[j];
        if (zh && zh.trim()) {
          ok++;
          db.update(cuesTable)
            .set({ textZh: zh, translationProvider: profile.name, updatedAt: now })
            .where(eq(cuesTable.id, cue.id))
            .run();
        }
      });
    } catch (err) {
      // 单批失败不中断：留空可后补（工坊单句重译 / 整卷重译）
      console.error(`翻译批次失败（${i / BATCH + 1}）：`, err instanceof Error ? err.message : err);
    }
    updateJob(jobId, {
      progress: from + (to - from) * Math.min(1, (i + BATCH) / targets.length),
      message: `翻译中 ${Math.min(i + BATCH, targets.length)}/${targets.length}…`,
    });
  }
  return { ok, total: targets.length };
}

/**
 * 统计与收尾：句数/去重词数/波形峰值/状态 ready
 * @param jobId 管线任务 id
 * @param materialId 材料 id
 * @param mediaAbsPath 媒体绝对路径（可空：媒体缺失时跳过峰值）
 */
async function finalizeMaterial(
  jobId: string,
  materialId: number,
  mediaAbsPath: string | null
): Promise<void> {
  const db = getDb();
  const rows = db
    .select({ textEn: cuesTable.textEn })
    .from(cuesTable)
    .where(eq(cuesTable.materialId, materialId))
    .all();
  const sentenceCount = rows.length;
  const uniqueWords = uniqueWordCount(rows.map((r) => r.textEn).join('\n'));

  let peaksRel: string | null = null;
  if (mediaAbsPath) {
    // 波形峰值 best-effort：失败不影响 ready
    try {
      const { peaks } = await enginePost<{ peaks: number[] }>('/media/peaks', {
        path: mediaAbsPath,
        buckets: 2000,
      });
      const { writeFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const peaksPath = join(dirname(mediaAbsPath), 'peaks.json');
      writeFileSync(peaksPath, JSON.stringify(peaks));
      peaksRel = peaksPath.replace(MEDIA_ROOT + '/', '');
    } catch {
      /* 峰值可后补 */
    }
  }

  db.update(materialsTable)
    .set({
      sentenceCount,
      uniqueWordCount: uniqueWords,
      subtitleStatus: 'ready',
      ...(peaksRel ? { peaksPath: peaksRel } : {}),
      updatedAt: new Date(),
    })
    .where(eq(materialsTable.id, materialId))
    .run();
  updateJob(jobId, { progress: 1, message: `完成：${sentenceCount} 句 / ${uniqueWords} 词` });
}

/**
 * 探测媒体元数据并回填材料行（best-effort）
 * @param mediaAbsPath 媒体绝对路径
 * @param materialId 材料 id
 */
async function probeMaterial(mediaAbsPath: string, materialId: number): Promise<void> {
  const db = getDb();
  try {
    const info = await enginePost<{
      duration_ms: number;
      size_bytes: number;
      mime: string | null;
    }>('/media/probe', { path: mediaAbsPath });
    db.update(materialsTable)
      .set({
        mediaDurationMs: info.duration_ms,
        mediaSizeBytes: info.size_bytes,
        ...(info.mime ? { mediaMime: info.mime } : {}),
        updatedAt: new Date(),
      })
      .where(eq(materialsTable.id, materialId))
      .run();
  } catch {
    /* 引擎离线时留空，管线后段会再探测 */
  }
}

/**
 * 本地引擎模型下载管线（设置页「下载模型」；payload.engine 当前仅 kokoro）
 *
 * 走引擎任务队列执行（web 编排、引擎计算）；引擎侧下载幂等（本地优先：
 * 在位文件直接复用，缺啥补啥），web/引擎任一重启后 recovery 重跑即续传，
 * 不产生孤儿任务——此前专用代理路由自提交自轮询，绕开了本管线约定。
 */
async function modelDownloadPipeline(jobId: string, payload: { engine?: string }): Promise<void> {
  const target = payload.engine ?? 'kokoro';
  updateJob(jobId, { progress: 0, message: `准备下载 ${target} 模型…` });
  const engineJob = await engineSubmitJob('model_download', { engine: target });
  updateJob(jobId, { engineJobId: engineJob.id });
  await engineAwaitJob(engineJob.id, {
    onProgress: (s) => updateJob(jobId, { progress: s.progress, message: s.message ?? '下载中…' }),
  });
  updateJob(jobId, { status: 'succeeded', progress: 1, message: '模型已就绪', finishedAt: new Date() });
}

/* ---------------------------------------------------------------------------
 * 管线主体
 * ------------------------------------------------------------------------- */

/**
 * 执行管线（按任务行类型分发；幂等：已完成步骤自动跳过）
 * @param jobId 任务 id
 */
async function runPipeline(jobId: string): Promise<void> {
  const db = getDb();
  const job = db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).all()[0];
  if (!job) return;
  updateJob(jobId, { status: 'running', startedAt: job.startedAt ?? new Date(), error: null });
  try {
    switch (job.type) {
      case 'import':
        await importPipeline(jobId, job.materialId!, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'restt':
        await resttMaterialPipeline(jobId, job.materialId!, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'retranslate':
        await retranslatePipeline(jobId, job.materialId!, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'restt_cue':
        await resttCuePipeline(jobId, job.cueId!, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'ai_analysis':
        await aiAnalysisPipeline(jobId, job.cueId!, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'ai_note':
        await aiNotePipeline(jobId, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'ai_quiz':
        await aiQuizPipeline(jobId, job.materialId!);
        break;
      case 'ai_level':
        await aiLevelPipeline(jobId, job.cueId!);
        break;
      case 'deep_card':
        await deepCardPipeline(jobId, JSON.parse(job.payloadJson ?? '{}'));
        break;
      case 'model_download':
        await modelDownloadPipeline(jobId, JSON.parse(job.payloadJson ?? '{}'));
        break;
      default:
        throw new Error(`未知管线类型：${job.type}`);
    }
    updateJob(jobId, { status: 'succeeded', finishedAt: new Date() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: 'failed', error: msg, finishedAt: new Date() });
    // 导入失败时材料状态同步 failed（可从材料卡重试）
    if (job.materialId) {
      db.update(materialsTable)
        .set({ subtitleStatus: 'failed', updatedAt: new Date() })
        .where(
          and(eq(materialsTable.id, job.materialId), eq(materialsTable.subtitleStatus, 'processing'))
        )
        .run();
    }
  }
}

/** 导入管线参数形态 */
interface ImportPayload {
  kind: 'upload' | 'link' | 'text';
  /** upload：媒体绝对路径 */
  mediaPath?: string;
  /** upload：随附字幕文件内容（已读入） */
  subtitleText?: string;
  /** link：原始 URL */
  url?: string;
  /** link：是否要视频 */
  wantVideo?: boolean;
  /** text：全文（路由已建 cues 时不需要） */
  text?: string;
  /** 使用的档案（导入向导临时选择） */
  sttProfileId?: number;
  translateProfileId?: number;
  ttsProfileId?: number;
}

/**
 * 导入主管线：三形态按步骤链执行（幂等）
 */
async function importPipeline(jobId: string, materialId: number, payload: ImportPayload): Promise<void> {
  const db = getDb();
  const material = db
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.id, materialId))
    .all()[0];
  if (!material) throw new Error('材料不存在');
  const dir = materialDir(material.collectionId, materialId);
  db.update(materialsTable)
    .set({ subtitleStatus: 'processing', updatedAt: new Date() })
    .where(eq(materialsTable.id, materialId))
    .run();

  const existingCueCount = db
    .select({ n: sql<number>`count(*)` })
    .from(cuesTable)
    .where(eq(cuesTable.materialId, materialId))
    .all()[0]!.n;

  let mediaAbs: string | null = null;

  if (payload.kind === 'link' && payload.url) {
    // —— 链接下载（幂等：媒体文件已存在则跳过）——
    const existing = db
      .select({ mediaPath: materialsTable.mediaPath })
      .from(materialsTable)
      .where(eq(materialsTable.id, materialId))
      .all()[0];
    if (existing?.mediaPath) {
      mediaAbs = `${MEDIA_ROOT}/${existing.mediaPath}`;
    } else {
      updateJob(jobId, { message: '链接解析与下载中…', progress: 0.02 });
      const dl = await engineSubmitJob('yt_download', {
        url: payload.url,
        out_dir: dir,
        want_video: payload.wantVideo ?? true,
      });
      updateJob(jobId, { engineJobId: dl.id });
      const result = (await engineAwaitJob(dl.id, {
        onProgress: (s) => updateJob(jobId, { progress: 0.02 + s.progress * 0.28, message: s.message ?? '下载中…' }),
      })) as { media_path: string; info: Record<string, unknown>; subtitle_path: string | null };

      mediaAbs = result.media_path;
      const { readFileSync, existsSync } = await import('node:fs');
      db.update(materialsTable)
        .set({
          mediaPath: result.media_path.replace(MEDIA_ROOT + '/', ''),
          title: (result.info.title as string) ?? material.title,
          sourceUrl: payload.url,
          metadataJson: existsSync(`${dir}/media.info.json`)
            ? readFileSync(`${dir}/media.info.json`, 'utf-8').slice(0, 20000)
            : JSON.stringify(result.info),
          updatedAt: new Date(),
        })
        .where(eq(materialsTable.id, materialId))
        .run();
      await probeMaterial(mediaAbs, materialId);
      // 官方英文字幕：免 STT 直入
      if (result.subtitle_path && existingCueCount === 0) {
        const subText = readFileSync(result.subtitle_path, 'utf-8');
        const rows = parseSubtitleText(subText);
        saveCues(materialId, rows);
      }
    }
  } else if (payload.mediaPath) {
    mediaAbs = payload.mediaPath;
  }

  // —— 文本导入：路由已建 cues（无时间轴）；此处合成音频并回填 ——
  if (payload.kind === 'text') {
    const cueRows = db
      .select()
      .from(cuesTable)
      .where(eq(cuesTable.materialId, materialId))
      .all()
      .sort((a, b) => a.index - b.index);
    const needsAudio = cueRows.length > 0 && !material.mediaPath;
    if (needsAudio) {
      const profile = resolveProfile('tts', payload.ttsProfileId);
      // 档案决定引擎路由（params.engine：edge 联网 / kokoro 本地离线；判别与
      // 引擎侧/缓存指纹同一实现）；音色缺省交给引擎按引擎默认（edge=Ryan / kokoro=George）
      const engineKind = ttsEngineFromParams(profile?.params);
      updateJob(jobId, {
        message: `语音合成中（${engineKind} · ${profile?.model ?? '默认音色'}）…`,
        progress: 0.05,
      });
      const outPath = `${dir}/tts.mp3`;
      const job = await engineSubmitJob('tts_batch', {
        sentences: cueRows.map((c) => c.textEn),
        out_path: outPath,
        // voice 仅本地档案传（本地档案 model 字段即音色）；云端档案 model 是
        // 模型名（如 qwen-audio-3.0-tts-plus），作 voice 传会被引擎云端音色
        // 链的最高优先级 req_voice 采纳——模型名当音色发给云端必合成失败。
        // 云端音色走 profile.params.voice（引擎侧解析，缺省用默认音色）
        voice: profile?.kind === 'local' ? ((profile.model as string) || undefined) : undefined,
        profile: profile ? toEngineProfile(profile) : {},
      });
      updateJob(jobId, { engineJobId: job.id });
      const result = (await engineAwaitJob(job.id, {
        onProgress: (s) => updateJob(jobId, { progress: 0.05 + s.progress * 0.55, message: s.message ?? '合成中…' }),
      })) as { path: string; timeline: Array<{ startMs: number; endMs: number }> };

      // 回填时间轴
      const now = new Date();
      db.transaction((tx) => {
        cueRows.forEach((cue, i) => {
          const t = result.timeline[i];
          if (t) {
            tx.update(cuesTable)
              .set({ startMs: t.startMs, endMs: t.endMs, updatedAt: now })
              .where(eq(cuesTable.id, cue.id))
              .run();
          }
        });
      });
      db.update(materialsTable)
        .set({
          mediaPath: result.path.replace(MEDIA_ROOT + '/', ''),
          mediaMime: 'audio/mpeg',
          updatedAt: now,
        })
        .where(eq(materialsTable.id, materialId))
        .run();
      mediaAbs = result.path;
      await probeMaterial(result.path, materialId);
    }
  }

  // —— 随附字幕直入（upload 携带 subtitleText；幂等：已有 cues 跳过）——
  if (payload.subtitleText && existingCueCount === 0) {
    const rows = parseSubtitleText(payload.subtitleText);
    saveCues(materialId, rows);
  }

  // —— STT（cues 仍为空时）——
  const cueCount = db
    .select({ n: sql<number>`count(*)` })
    .from(cuesTable)
    .where(eq(cuesTable.materialId, materialId))
    .all()[0]!.n;
  if (cueCount === 0 && mediaAbs) {
    // 抽取 16kHz wav（幂等：文件已存在跳过）
    const { existsSync } = await import('node:fs');
    const wav = `${dir}/stt.wav`;
    if (!existsSync(wav)) {
      updateJob(jobId, { message: '抽取音频…', progress: 0.3 });
      await enginePost('/media/extract-audio', { source: mediaAbs, out_wav: wav });
    }
    await runSttAndSaveCues(jobId, materialId, wav, payload.sttProfileId, [0.35, 0.75]);
    // STT 后用词流时长校正媒体时长（whisper info.duration 更接近真实）
    await probeMaterial(mediaAbs, materialId);
  }

  // —— 翻译 + 统计收尾 ——
  await translateMaterial(jobId, materialId, payload.translateProfileId, true, [0.8, 0.98]);
  await finalizeMaterial(jobId, materialId, mediaAbs);
}

/**
 * 整材料重 STT 管线（工坊「重新 STT」）
 */
async function resttMaterialPipeline(
  jobId: string,
  materialId: number,
  payload: { sttProfileId?: number; translateProfileId?: number }
): Promise<void> {
  const db = getDb();
  const material = db
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.id, materialId))
    .all()[0];
  if (!material?.mediaPath) throw new Error('材料无媒体文件');
  const dir = materialDir(material.collectionId, materialId);
  const mediaAbs = `${MEDIA_ROOT}/${material.mediaPath}`;
  const wav = `${dir}/stt.wav`;
  const { existsSync } = await import('node:fs');
  if (!existsSync(wav)) {
    updateJob(jobId, { message: '抽取音频…', progress: 0.05 });
    await enginePost('/media/extract-audio', { source: mediaAbs, out_wav: wav });
  }
  db.update(materialsTable)
    .set({ subtitleStatus: 'processing', updatedAt: new Date() })
    .where(eq(materialsTable.id, materialId))
    .run();
  // 注意：重 STT 保留人工译文？——设计取舍：重 STT 替换原文，译文按句序对齐保留尽力而为，
  // 简化实现为全量替换（译文丢弃可整卷重译）；M2 可加对齐保留
  await runSttAndSaveCues(jobId, materialId, wav, payload.sttProfileId, [0.1, 0.7]);
  await translateMaterial(jobId, materialId, payload.translateProfileId, true, [0.75, 0.98]);
  await finalizeMaterial(jobId, materialId, mediaAbs);
}

/**
 * 整材料重翻译管线
 */
async function retranslatePipeline(
  jobId: string,
  materialId: number,
  payload: { translateProfileId?: number; force?: boolean }
): Promise<void> {
  const db = getDb();
  const material = db
    .select({ mediaPath: materialsTable.mediaPath })
    .from(materialsTable)
    .where(eq(materialsTable.id, materialId))
    .all()[0];
  // force=true 时先清空全部译文
  if (payload.force) {
    db.update(cuesTable)
      .set({ textZh: null, translationProvider: null, updatedAt: new Date() })
      .where(eq(cuesTable.materialId, materialId))
      .run();
  }
  const r = await translateMaterial(jobId, materialId, payload.translateProfileId, true, [0.1, 0.95]);
  updateJob(jobId, {
    message: r.skippedNoProfile
      ? '未配置翻译档案，已跳过'
      : `翻译完成：${r.ok}/${r.total} 句成功（失败句可在工坊单句重译）`,
  });
  await finalizeMaterial(jobId, materialId, material?.mediaPath ? `${MEDIA_ROOT}/${material.mediaPath}` : null);
}

/**
 * 单句切片重 STT 管线（工坊单条纠错）
 */
async function resttCuePipeline(
  jobId: string,
  cueId: number,
  payload: { sttProfileId?: number; extendMs?: number }
): Promise<void> {
  const db = getDb();
  const cue = db.select().from(cuesTable).where(eq(cuesTable.id, cueId)).all()[0];
  if (!cue) throw new Error('句段不存在');
  const material = db
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.id, cue.materialId))
    .all()[0];
  if (!material?.mediaPath) throw new Error('材料无媒体文件');
  const dir = materialDir(material.collectionId, cue.materialId);

  // 切片（前后各放宽 200ms，防截掉首尾词）
  const extend = payload.extendMs ?? 200;
  const slicePath = `${dir}/.cue-${cueId}.wav`;
  await enginePost('/media/slice', {
    source: `${MEDIA_ROOT}/${material.mediaPath}`,
    start_ms: Math.max(0, cue.startMs - extend),
    end_ms: cue.endMs + extend,
    out_path: slicePath,
  });
  // 切片 STT：同步端点（短音频）
  const profile = resolveProfile('stt', payload.sttProfileId);
  if (!profile) throw new EngineError('无可用 STT 档案', 0);
  updateJob(jobId, { message: '单句重听写中…', progress: 0.4 });
  const result = await enginePost<STTResult>('/stt', {
    audio_path: slicePath,
    profile: toEngineProfile(profile),
    language: 'en',
  });
  const text = (result.words ?? []).map((w) => w.w).join(' ').trim();
  const { unlink } = await import('node:fs/promises');
  void unlink(slicePath).catch(() => undefined);
  if (!text) throw new EngineError('该时间区间未识别到语音', 0);
  db.update(cuesTable)
    .set({
      textEn: text,
      wordsJson: result.words?.length ? JSON.stringify(result.words) : null,
      sttConfidence: result.words?.length
        ? result.words.reduce((a, w) => a + (w.p ?? 0), 0) / result.words.length
        : null,
      isEdited: false,
      updatedAt: new Date(),
    })
    .where(eq(cuesTable.id, cueId))
    .run();
  updateJob(jobId, { message: '已替换原文', progress: 1 });
}

/** 句子 AI 解析系统提示（结构化 Markdown，风格呼应设计稿 ai_90 的三段式） */
const ANALYSIS_SYSTEM =
  '你是一位精通中英文的资深英语老师。对用户给出的英文句子做精读解析，' +
  '用中文输出 Markdown，包含以下小节：\n' +
  '## 句意\n一句话概括中译\n## 句法拆解\n主干结构、从句/修饰成分逐层拆解\n' +
  '## 词汇与表达\n关键词、地道搭配、易错点\n## 仿说模板\n给出一个可套用的句型模板与一个新例句';

/**
 * 句子 AI 解析管线（收藏 + 解析）
 */
async function aiAnalysisPipeline(jobId: string, cueId: number, payload: { favoriteId: number }): Promise<void> {
  const db = getDb();
  try {
    const profile = resolveProfile('llm');
    if (!profile || profile.kind !== 'cloud') {
      throw new EngineError('未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）', 0);
    }
    const cue = db.select().from(cuesTable).where(eq(cuesTable.id, cueId)).all()[0];
    if (!cue) throw new Error('句段不存在');
    updateJob(jobId, { message: `AI 解析中（${profile.name}）…`, progress: 0.3 });

    const { content } = await enginePost<{ content: string | null }>('/llm/chat', {
      profile: toEngineProfile(profile),
      system: ANALYSIS_SYSTEM,
      user: `英文原句：${cue.textEn}\n中文参考译文：${cue.textZh ?? '（无）'}`,
    });
    db.update(favoritesTable)
      .set({
        aiAnalysisMd: content ?? '',
        aiAnalysisStatus: 'ready',
        aiAnalysisProvider: profile.name,
        updatedAt: new Date(),
      })
      .where(eq(favoritesTable.id, payload.favoriteId))
      .run();
    updateJob(jobId, { progress: 1, message: '解析完成' });
  } catch (err) {
    // 失败必须落 'failed'：收藏页按 status 轮询，停在 pending 会无限轮询
    // （此前全链路无人写 failed，解析失败后收藏永久卡 pending）
    db.update(favoritesTable)
      .set({ aiAnalysisStatus: 'failed', updatedAt: new Date() })
      .where(eq(favoritesTable.id, payload.favoriteId))
      .run();
    throw err;
  }
}

/** 单词 AI 笔记系统提示 */
const WORD_NOTE_SYSTEM =
  '你是英语词汇专家。为用户给出的单词生成学习笔记，用中文输出 Markdown，包含：\n' +
  '## 释义\n词性与核心义项（中文）\n## 发音\n英式/美式音标\n## 词源\n简明词源故事\n' +
  '## 例句\n2 个例句（第一个尽量来自用户提供的原句语境）\n## 搭配\n高频搭配 3-5 个\n## 易混词\n1-2 个近形/近义词辨析';

/**
 * 单词 AI 笔记管线
 */
async function aiNotePipeline(jobId: string, payload: { wordId: number }): Promise<void> {
  const db = getDb();
  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    throw new EngineError('未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）', 0);
  }
  const word = db.select().from(wordsTable).where(eq(wordsTable.id, payload.wordId)).all()[0];
  if (!word) throw new Error('单词不存在');
  updateJob(jobId, { progress: 0.3, message: `AI 笔记生成中（${profile.name}）…` });
  const { content } = await enginePost<{ content: string | null }>('/llm/chat', {
    profile: toEngineProfile(profile),
    system: WORD_NOTE_SYSTEM,
    user: `单词：${word.displayForm}\n收录语境原句：${payloadOriginSentence(db, word.originCueId)}`,
  });
  db.update(wordsTable)
    .set({
      aiNoteMd: content ?? '',
      aiNoteStatus: 'ready',
      aiNoteProvider: profile.name,
      updatedAt: new Date(),
    })
    .where(eq(wordsTable.id, payload.wordId))
    .run();
  updateJob(jobId, { progress: 1, message: '笔记已生成' });
}

/** 辅助：取收录语境原句 */
function payloadOriginSentence(db: ReturnType<typeof getDb>, cueId: number | null): string {
  if (!cueId) return '（无）';
  const cue = db.select({ textEn: cuesTable.textEn }).from(cuesTable).where(eq(cuesTable.id, cueId)).all()[0];
  return cue?.textEn ?? '（无）';
}

export { updateJob as updateJobRow };

/* ---------------------------------------------------------------------------
 * 结构化 LLM 调用（测验 / 深学卡共用）
 * ------------------------------------------------------------------------- */

/**
 * 结构化 LLM 调用：云档案守卫 → /llm/chat want_json 生成 → zod 校验 →
 * 失败把错误回喂修复重试一次 → 仍失败抛 EngineError。
 * 此前测验与深学卡各持一份逐字相同的调用-校验-修复循环，重试策略/温度/
 * 提示词的任何调整都要改多处且必然漂移——收敛为单一实现。
 * @param opts.schema     zod schema（want_json 产物的安全解析）
 * @param opts.system     系统提示
 * @param opts.user       用户提示
 * @param opts.label      产物名（错误文案用，如「测验」「深学卡」）
 * @param opts.onProgress 进度回调（stage 区分首 generation 与修复重试两段）
 * @returns 解析后的数据与生效档案（provider 落库溯源用）
 */
async function structuredLLM<T>(opts: {
  schema: z.ZodType<T>;
  system: string;
  user: string;
  label: string;
  onProgress?: (stage: 'generate' | 'repair', message: string) => void;
}): Promise<{ data: T; profile: ResolvedProfile }> {
  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    throw new EngineError('未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）', 0);
  }

  // 进度文案复用调用方的领域 label（如「深学卡」「测验」），任务面板不丢上下文
  opts.onProgress?.('generate', `${opts.label}生成中（${profile.name}）…`);
  let r = await enginePost<{ json: unknown }>('/llm/chat', {
    profile: toEngineProfile(profile),
    system: opts.system,
    user: opts.user,
    want_json: true,
    temperature: 0.4,
  });
  let parsed = opts.schema.safeParse(r.json);

  // 修复重试一次（zod 校验失败 → 把错误回喂，修复提示词共用 quiz.ts 的 repairPrompt）
  if (!parsed.success) {
    opts.onProgress?.('repair', '结构校验未过，修复重试…');
    r = await enginePost<{ json: unknown }>('/llm/chat', {
      profile: toEngineProfile(profile),
      system: opts.system,
      user: `${opts.user}\n\n${repairPrompt(parsed.error.issues)}`,
      want_json: true,
      temperature: 0.2,
    });
    parsed = opts.schema.safeParse(r.json);
  }
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('；');
    throw new EngineError(`模型两次都未产出合规${opts.label}：${detail}`, 0);
  }
  return { data: parsed.data, profile };
}

/* ---------------------------------------------------------------------------
 * 测验生成管线（M2，需求 12）
 * ------------------------------------------------------------------------- */

/**
 * 测验生成：采样句段 → LLM 出题 → zod 严格校验（失败带错误修复重试一次）→ 产物落库
 */
async function aiQuizPipeline(jobId: string, materialId: number): Promise<void> {
  const db = getDb();
  const material = db
    .select()
    .from(materialsTable)
    .where(eq(materialsTable.id, materialId))
    .all()[0];
  if (!material) throw new Error('材料不存在');

  // 采样句段：按句序均匀取最多 12 句（开头/中间/结尾都覆盖）
  const allCues = db
    .select({ index: cuesTable.index, textEn: cuesTable.textEn, textZh: cuesTable.textZh })
    .from(cuesTable)
    .where(eq(cuesTable.materialId, materialId))
    .all()
    .sort((a, b) => a.index - b.index);
  if (allCues.length < 3) throw new Error('句段太少，无法出题（至少 3 句）');
  // 均匀采样：等距下标必然含首句与末句（step 取整会漏尾，这里用比例插值）
  const SAMPLE_CAP = 12;
  const cap = Math.min(SAMPLE_CAP, allCues.length);
  const sampled: typeof allCues = [];
  for (let k = 0; k < cap; k++) {
    const idx = cap === 1 ? 0 : Math.round((k * (allCues.length - 1)) / (cap - 1));
    sampled.push(allCues[idx]!);
  }

  updateJob(jobId, { progress: 0.2, message: `AI 出题中（采样 ${sampled.length} 句）…` });

  // 结构化生成（共享 structuredLLM：校验 + 修复重试 + 档案守卫）
  const { data: quiz, profile } = await structuredLLM({
    schema: QuizSchema,
    system: QUIZ_SYSTEM,
    user: buildQuizPrompt(material.title, sampled),
    label: '测验',
    onProgress: (stage, message) => updateJob(jobId, { progress: stage === 'generate' ? 0.3 : 0.6, message }),
  });

  db.insert(aiArtifacts)
    .values({
      userId: 1,
      kind: 'quiz',
      subjectType: 'material',
      subjectId: materialId,
      provider: profile.name,
      contentMd: JSON.stringify(quiz),
      createdAt: new Date(),
    })
    .run();
  updateJob(jobId, { progress: 1, message: `已生成测验「${quiz.title}」（${quiz.questions.length} 题）` });
}

/* ---------------------------------------------------------------------------
 * AI 关卡生成管线（M3，需求 8：针对单句生成闯关交互网页）
 * ------------------------------------------------------------------------- */

/** 关卡生成系统提示 */
const LEVEL_SYSTEM =
  '你是交互式英语练习网页生成器。基于给定英文句子生成一个自包含的 HTML 闯关小游戏。' +
  '硬性要求：单个 HTML 文件、不引用任何外部资源（无 CDN/字体/图片请求）、' +
  '内联 <style> 与 <script>、移动端优先（viewport、触控友好）、纸墨风格' +
  '（暖纸底色 #FBF9F5、朱砂 #B91C1C、浓墨 #1E2022、圆角 4px、细边框）。' +
  '玩法：把该句拆成打乱的词块/填空/配对等小关卡，答对给反馈，全部完成显示「通关」。' +
  '只输出 HTML 源码本身，不要任何解释，不要 Markdown 代码围栏。';

/**
 * 关卡生成：LLM 产 HTML → 剥可能的围栏 → 落盘 ~/.pinglc/artifacts/ → ai_artifacts 登记
 */
async function aiLevelPipeline(jobId: string, cueId: number): Promise<void> {
  const db = getDb();
  const profile = resolveProfile('llm');
  if (!profile || profile.kind !== 'cloud') {
    throw new EngineError('未配置 LLM 档案（设置页添加 GLM/DeepSeek/GPT 等端点）', 0);
  }
  const cue = db.select().from(cuesTable).where(eq(cuesTable.id, cueId)).all()[0];
  if (!cue) throw new Error('句段不存在');

  updateJob(jobId, { progress: 0.2, message: `AI 关卡生成中（${profile.name}）…` });
  const { content } = await enginePost<{ content: string | null }>('/llm/chat', {
    profile: toEngineProfile(profile),
    system: LEVEL_SYSTEM,
    user: `英文原句：${cue.textEn}\n中文译文：${cue.textZh ?? '（无）'}\n\n生成闯关网页。`,
    temperature: 0.5,
  });
  let html = (content ?? '').trim();
  // 剥 ```html 围栏（模型偶发不守约）
  const fence = html.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/);
  if (fence) html = fence[1]!.trim();
  if (!/<html[\s>]/i.test(html) || html.length < 200) {
    throw new EngineError('模型未返回有效 HTML 关卡页', 0);
  }

  // 落盘与登记（绝对路径存 artifactPath，/artifacts/[id] 路由校验 .pinglc 前缀后直读）
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const dir = join(homedir(), '.pinglc', 'artifacts');
  mkdirSync(dir, { recursive: true });
  const fileName = `level-${cueId}-${Date.now()}.html`;
  const abs = join(dir, fileName);
  writeFileSync(abs, html, 'utf-8');

  db.insert(aiArtifacts)
    .values({
      userId: 1,
      kind: 'level_page',
      subjectType: 'cue',
      subjectId: cueId,
      provider: profile.name,
      artifactPath: abs,
      createdAt: new Date(),
    })
    .run();
  updateJob(jobId, { progress: 1, message: '关卡已生成' });
}

/* ---------------------------------------------------------------------------
 * 深学卡管线（M4：词源拓扑 + 仿写构架）
 * ------------------------------------------------------------------------- */

/**
 * 深学卡：LLM 一次产出词源树 + 仿写构架 → zod 校验（失败修复重试一次）→
 * 词源写 words.etymologyJson，构架写 ai_artifacts('imitation')
 */
async function deepCardPipeline(jobId: string, payload: { wordId: number }): Promise<void> {
  const db = getDb();
  const word = db.select().from(wordsTable).where(eq(wordsTable.id, payload.wordId)).all()[0];
  if (!word) throw new Error('单词不存在');
  const example = payloadOriginSentence(db, word.originCueId);

  // 结构化生成（共享 structuredLLM：校验 + 修复重试 + 档案守卫）
  const { data: card, profile } = await structuredLLM({
    schema: DeepCardSchema,
    system: DEEP_SYSTEM,
    user: buildDeepPrompt(word.displayForm, example === '（无）' ? null : example),
    label: '深学卡',
    onProgress: (stage, message) => updateJob(jobId, { progress: stage === 'generate' ? 0.2 : 0.6, message }),
  });

  const now = new Date();
  // 词源树 → words.etymologyJson（词藏页直接渲染）
  // frames 即数组本体（zod intersection 输出 A & { frames: [...] }，解构所得
  // 为数组；e2e 已验证前端契约 Array<{pattern,tip}> 直读）
  const { frames, ...etymology } = card;
  // 仿写构架 → ai_artifacts（kind=imitation，同词覆盖式更新：先删旧）。
  // 三条写库同一事务：中途崩溃不留「旧词源 + 构架尽失」的半张卡
  db.transaction((tx) => {
    tx.update(wordsTable)
      .set({ etymologyJson: JSON.stringify(etymology), updatedAt: now })
      .where(eq(wordsTable.id, word.id))
      .run();
    tx.delete(aiArtifacts)
      .where(and(eq(aiArtifacts.kind, 'imitation'), eq(aiArtifacts.subjectType, 'word'), eq(aiArtifacts.subjectId, word.id)))
      .run();
    tx.insert(aiArtifacts)
      .values({
        userId: 1,
        kind: 'imitation',
        subjectType: 'word',
        subjectId: word.id,
        provider: profile.name,
        contentMd: JSON.stringify(frames),
        createdAt: now,
      })
      .run();
  });
  updateJob(jobId, { progress: 1, message: '深学卡已生成' });
}
