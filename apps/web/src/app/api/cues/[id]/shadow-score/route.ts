/**
 * 跟读评分 API（闯关「跟读评分/影子跟读」玩法共用）
 * POST /api/cues/[id]/shadow-score  body = 录音音频字节
 *
 * 双路径评分（按配置自动路由）：
 * - 云端口语评测（engine=soe）：设置页配置 speech_eval 档案（腾讯云 SOE）时优先，
 *   引擎 /soe 转码上传录音 → 词级+音素级评分（准确度/流利度/完整度）
 * - 本地近似评分（engine=proxy）：未配置或云端失败时兜底——录音经引擎 STT 转写 →
 *   与目标句 diffSentence 词级相似度 → 0~100 分（可离线可用）
 */

import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import {
  diffSentence,
  type ShadowScoreDTO,
  type SoeEvalResult,
  type SpeechEvalDetail,
} from '@pinglc/core';
import { eq } from 'drizzle-orm';
import { getDb, PINGLC_HOME } from '@/lib/db';
import { cues } from '@/lib/db/schema';
import { EngineError, enginePost } from '@/lib/server/engine';
import { resolveProfile, toEngineProfile } from '@/lib/server/providers';

export const runtime = 'nodejs';

/** 评分录音上限 5MB */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 云端口语评测（引擎 /soe）：归一化为 ShadowScoreDTO 的 soe 路径
 * @param tmpPath 录音临时文件路径（~/.pinglc/tmp 之内，引擎侧校验）
 * @param refText 目标句英文
 * @param profile 已解析的 speech_eval 云端档案（凭据随 profile 传引擎，不落日志）
 */
async function scoreBySoe(
  tmpPath: string,
  refText: string,
  profile: NonNullable<ReturnType<typeof resolveProfile>>
): Promise<ShadowScoreDTO> {
  const result = await enginePost<SoeEvalResult>('/soe', {
    audio_path: tmpPath,
    ref_text: refText,
    profile: toEngineProfile(profile),
    language: 'en',
  });
  // heard 重建：剔除漏读词（match_tag=2 是「该读没读」，不在音频里）；
  // 增读词（1）是真说出的内容，保留在 heard 里
  const heard = (result.words ?? [])
    .filter((w) => w.match_tag !== 2)
    .map((w) => w.word)
    .filter(Boolean)
    .join(' ');
  const detail: SpeechEvalDetail = {
    accuracy: result.accuracy ?? 0,
    fluency: result.fluency ?? 0,
    completion: result.completion ?? 0,
    words: (result.words ?? []).map((w) => ({
      word: w.word,
      accuracy: w.accuracy,
      matchTag: w.match_tag,
      beginMs: w.begin_ms,
      endMs: w.end_ms,
      // 音素级明细（phone=实际发音 / reference_phone=标准音素 / 重音检出）
      phones: (w.phones ?? []).map((p) => ({
        phone: p.phone,
        referencePhone: p.reference_phone,
        accuracy: p.accuracy,
        matchTag: p.match_tag,
        stress: p.stress,
        detectedStress: p.detected_stress,
      })),
    })),
  };
  return {
    score: Math.max(0, Math.min(100, Math.round(result.score ?? 0))),
    heard,
    diff: null,
    note: (result.words ?? []).length === 0 ? '未检测到有效语音（声音太小或环境嘈杂）' : null,
    engine: 'soe',
    detail,
  };
}

/**
 * POST —— body = audio blob（webm/mp4）；返回 ShadowScoreDTO
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cueId = Number(id);
  const db = getDb();
  const cue = db.select().from(cues).where(eq(cues.id, cueId)).all()[0];
  if (!cue) return NextResponse.json({ error: '句段不存在' }, { status: 404 });

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: '录音为空' }, { status: 400 });
  if (buf.length > MAX_BYTES) return NextResponse.json({ error: '录音过大' }, { status: 413 });

  // 临时文件（评分不留存）：独立 tmp 目录，不混入引擎的内容哈希缓存；
  // mkdirSync 幂等——引擎未启动过也能评分
  const tmpDir = join(PINGLC_HOME, 'tmp');
  const tmpPath = join(tmpDir, `shadow-${cueId}-${Date.now()}.webm`);
  // 云端口语评测失败时的降级说明（本地近似评分的 note 里提示原因）
  let soeFallbackNote: string | null = null;
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpPath, buf);

    // 路径一：云端口语评测（已配置 speech_eval 云端档案时优先）
    const soeProfile = resolveProfile('speech_eval');
    if (soeProfile && soeProfile.kind === 'cloud') {
      try {
        return NextResponse.json(await scoreBySoe(tmpPath, cue.textEn, soeProfile));
      } catch (err) {
        // 云端失败不阻断：降级本地近似评分，note 带原因（凭据错误/欠费/网络…）
        soeFallbackNote =
          `口语评测服务不可用（${err instanceof EngineError ? err.message : '网络异常'}），已用本地近似评分`;
      }
    }

    // 路径二：本地近似评分——引擎同步 STT（短音频）→ diffSentence 词级相似度；
    // 评分固定用 base 小模型（快、且与生成转写档案解耦）
    const sttProfile = toEngineProfile({
      kind: 'local',
      params: {},
      name: '评分',
      profileId: 0,
      model: 'base',
    });
    const result = await enginePost<{ words: Array<{ w: string }> }>('/stt', {
      audio_path: tmpPath,
      profile: sttProfile,
      language: 'en',
    });
    const heard = (result.words ?? []).map((w) => w.w).join(' ').trim();
    if (!heard) {
      return NextResponse.json({
        score: 0,
        heard: '',
        diff: null,
        note: soeFallbackNote ?? '未识别到语音（声音太小或环境嘈杂）',
        engine: 'proxy',
        detail: null,
      } satisfies ShadowScoreDTO);
    }
    const diff = diffSentence(cue.textEn, heard);
    return NextResponse.json({
      score: Math.round(diff.score * 100),
      heard,
      diff: { items: diff.items.map((x) => ({ target: x.target, typed: x.typed, status: x.status })), exact: diff.exact },
      note: soeFallbackNote,
      engine: 'proxy',
      detail: null,
    } satisfies ShadowScoreDTO);
  } catch (err) {
    const msg = err instanceof EngineError ? err.message : '评分失败';
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 清理失败无害 */
    }
  }
}
