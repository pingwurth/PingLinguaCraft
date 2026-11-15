/**
 * 版本化 TTS 朗读 URL（客户端共用：播放器点词朗读 / 复习听音辨词）
 *
 * 先取当前 TTS 档案指纹（模块级记忆，避免每次播放多一跳请求），再拼带 v
 * 的音频 URL：档案（引擎/音色/端点）变 → v 变 → 浏览器按新 URL 请求，不命中
 * 旧音色的不可变缓存。设置页保存 TTS 档案后调 resetTtsVersion 立即生效。
 * 取指纹失败不记忆——服务端对不符的 v 一律 302 到当期版本（见
 * api/media/tts/route.ts），v=0 占位 URL 仍能播对音频，但下次播放会重试
 * 取指纹（此前失败被钉成 '0' 后整个会话都不再重试）。
 */

/** 当前会话记忆的档案指纹（null=未取过/上次获取失败待重试） */
let memoV: string | null = null;
/** 上次取指纹失败的时间戳（冷却窗内不再重试——服务持续不可达时不能让每次点词都先卡一跳慢请求） */
let lastFailAt = 0;
/** 失败重试冷却窗（毫秒） */
const RETRY_COOLDOWN_MS = 30_000;
/** 单次取指纹的等待上限（毫秒）：超时按失败处理，快速退化到 v=0 占位（服务端 302 兜底当期档案） */
const VERSION_FETCH_TIMEOUT_MS = 3_000;

/** 使记忆的指纹失效（设置页保存/切换 TTS 档案后调用，下次播放取新值；同时解除失败冷却） */
export function resetTtsVersion(): void {
  memoV = null;
  lastFailAt = 0;
}

/**
 * 构造版本化朗读 URL
 * @param text 待合成文本
 * @param voice 显式音色（可选；缺省用当前档案）
 */
export async function ttsAudioUrl(text: string, voice?: string): Promise<string> {
  if (memoV === null && Date.now() - lastFailAt > RETRY_COOLDOWN_MS) {
    try {
      const r = await fetch('/api/media/tts/version', { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
      // 只有拿到非空指纹才记忆；失败/空值保持 null，冷却窗后重试
      const v = ((await r.json()) as { v?: string }).v;
      if (v) memoV = v;
    } catch {
      // 超时/网络失败不落记忆、记冷却：本次用占位 v=0（服务端 302 兜底到当期档案）
      lastFailAt = Date.now();
    }
  }
  const q = new URLSearchParams({ text, v: memoV ?? '0' });
  if (voice) q.set('voice', voice);
  return `/api/media/tts?${q.toString()}`;
}
