/**
 * TTS 音色清单代理：GET /api/engine/tts-voices
 *
 * 透传引擎 /tts/voices（edge 联网 / kokoro 本地离线 / 云端阿里云三套清单
 * 与三引擎默认音色），设置页 TTS 档案表单的引擎与音色下拉用；契约类型
 * （TtsVoiceOptions）在 @pinglc/core 单一声明；引擎离线时回 502 带提示。
 */

import { NextResponse } from 'next/server';
import type { TtsVoiceOptions } from '@pinglc/core';
import { engineGet, engineErrorResponse } from '@/lib/server/engine';

export const runtime = 'nodejs';

/**
 * GET —— 返回 TtsVoiceOptions：{ edge, kokoro, cloud: TtsVoiceOption[],
 * defaults: { edge, kokoro, cloud } }（清单与默认值均只在引擎持一份）
 */
export async function GET() {
  try {
    const voices = await engineGet<TtsVoiceOptions>('/tts/voices');
    return NextResponse.json(voices);
  } catch (err) {
    return engineErrorResponse(err, '音色清单获取失败');
  }
}
