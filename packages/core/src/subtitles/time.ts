/**
 * 字幕时间码工具：毫秒 <-> SRT/VTT 时间字符串互转
 *
 * SRT 使用逗号毫秒（00:00:01,000），VTT 使用点毫秒（00:00:01.000），
 * 本模块提供统一的解析与格式化函数，供 srt.ts / vtt.ts 复用。
 */

/** 最大允许的毫秒值（防止异常输入生成非法时间码） */
const MAX_MS = 1000 * 60 * 60 * 24 * 30; // 30 天，远超任何单条媒体长度

/**
 * 将时间字符串解析为毫秒数
 * 同时兼容 SRT（逗号）与 VTT（点）两种毫秒分隔符，也兼容省略小时的短格式（mm:ss.mmm）
 * @param raw 原始时间字符串，如 "00:01:02,500" / "00:01:02.500" / "01:02.5"
 * @returns 毫秒数；解析失败返回 null
 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim();
  // 匹配 h:mm:ss[:,.]mmm 或 mm:ss[:,.]mmm 两种形态
  const m = text.match(
    /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/
  );
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2]!, 10);
  const sec = parseInt(m[3]!, 10);
  // 范围校验：分/秒不得超过 59，小时不得超过 999（99:99:99 之类视为非法）
  if (min > 59 || sec > 59 || h > 999) return null;
  const msFrac = m[4] ? m[4].padEnd(3, '0') : '000';
  const ms = parseInt(msFrac, 10);
  const total = ((h * 60 + min) * 60 + sec) * 1000 + ms;
  if (Number.isNaN(total) || total < 0 || total > MAX_MS) return null;
  return total;
}

/**
 * 将毫秒数格式化为时间字符串
 * @param ms        毫秒数
 * @param separator 毫秒分隔符：SRT 用 ","，VTT 用 "."
 * @returns 形如 "HH:MM:SS,mmm" 的字符串
 */
export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`;
}
