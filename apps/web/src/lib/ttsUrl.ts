/**
 * 版本化 TTS 朗读 URL（客户端共用：播放器点词朗读 / 复习听音辨词）
 *
 * 先取当前 TTS 档案指纹（模块级记忆，避免每次播放多一跳请求），再拼带 v
 * 的音频 URL：档案（引擎/音色）变 → v 变 → 浏览器按新 URL 请求，不命中
 * 旧音色的不可变缓存。设置页保存 TTS 档案后调 resetTtsVersion 立即生效。
 */

/** 当前会话记忆的档案指纹（null=未取过） */
let memoV: string | null = null;

/** 使记忆的指纹失效（设置页保存/切换 TTS 档案后调用，下次播放取新值） */
export function resetTtsVersion(): void {
  memoV = null;
}

/**
 * 构造版本化朗读 URL
 * @param text 待合成文本
 * @param voice 显式音色（可选；缺省用当前档案）
 */
export async function ttsAudioUrl(text: string, voice?: string): Promise<string> {
  if (!memoV) {
    try {
      const r = await fetch('/api/media/tts/version');
      memoV = ((await r.json()) as { v?: string }).v ?? '0';
    } catch {
      memoV = '0'; // 取指纹失败退化为占位版本（URL 仍有效，经 302 兜底当期档案）
    }
  }
  const q = new URLSearchParams({ text, v: memoV });
  if (voice) q.set('voice', voice);
  return `/api/media/tts?${q.toString()}`;
}
