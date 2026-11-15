/**
 * 媒体时间轴工具（双端共享的纯逻辑）
 *
 * 前置条件（调用方保证）：cue 按 startMs 升序且区间互不重叠——STT 产出
 * 路径已做重叠修正（nlp/sentences）；字幕导入路径（parseGeneric）按文件
 * 块序原样落库，遇到乱序/重叠字幕文件时需调用方先行归一化，否则二分会在
 * 乱序/重叠区间漏判（返回 -1 或跳段）。
 * 「当前时间落在哪一句」用二分而非线性扫描：web 播放器 rAF 时钟与
 * mobile 音频事件回调共用此实现。
 */

/**
 * 找到包含时间 t 的句段下标（无命中返回 -1）
 * @param cues 句段数组（按 startMs 升序）
 * @param t    查询时间（毫秒）
 */
export function findCueIndex(
  cues: Array<{ startMs: number; endMs: number }>,
  t: number
): number {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.startMs) hi = mid - 1;
    else if (t >= c.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}
