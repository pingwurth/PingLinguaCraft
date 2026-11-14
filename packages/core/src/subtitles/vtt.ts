/**
 * WebVTT 字幕文件的解析与序列化
 *
 * 与 SRT 块结构同构，解析复用 block.ts 通用解析器；
 * 差异仅在：毫秒分隔符为 "."、需要 WEBVTT 头、NOTE/STYLE/REGION 块、cue 附加设置，
 * 以及 HLS 来源的 X-TIMESTAMP-MAP 头（MPEGTS 时间基准偏移，见 parseVtt）。
 */

import { formatTimestamp, parseTimestamp } from './time';
import { parseGeneric, pickCueLines } from './block';
import type { ParseResult } from './block';
import type { Cue } from '../types';

/**
 * 解析 WebVTT 字幕文本为句段数组
 *
 * 若文件头带 X-TIMESTAMP-MAP=LOCAL:...,MPEGTS:...（yt-dlp 抓取的 HLS 字幕常见），
 * 按「MPEGTS(90kHz) 换算毫秒 − LOCAL 毫秒」整体平移全部句段时间，
 * 保证与实际媒体时间轴对齐；头格式非法时记录错误并按原时间解析。
 * 偏移使句段整体落到 0 之前时丢弃该句段并报错（不钳成堆在原点的零长句段）。
 * 局限：MPEGTS 计数器回绕（直播超长流）与 HLS 分片拼接的多份映射不处理（后者报错）。
 * @param text VTT 文件全文
 * @returns 句段列表（index 按 0 起重新编号）与错误信息列表
 */
export function parseVtt(text: string): ParseResult {
  const errors: string[] = [];

  // X-TIMESTAMP-MAP 只会出现在文件头区域（首条空行之前）：正则限定在该区域匹配，
  // 避免把恰好以 X-TIMESTAMP-MAP= 开头的字幕文本行误当作偏移头、从正文删除
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  const headerRegion = headerEnd === -1 ? normalized : normalized.slice(0, headerEnd);
  const restRegion = headerEnd === -1 ? '' : normalized.slice(headerEnd);
  const mapMatch = headerRegion.match(/^X-TIMESTAMP-MAP=.*$/m);
  let offsetMs = 0;
  let body = normalized;
  if (mapMatch) {
    const local = mapMatch[0].match(/LOCAL:\s*([\d:.]+)/);
    const mpegts = mapMatch[0].match(/MPEGTS:\s*(\d+)/);
    const localMs = local ? parseTimestamp(local[1]!) : null;
    if (!mpegts || localMs === null) {
      errors.push(`X-TIMESTAMP-MAP 头格式非法 "${mapMatch[0].trim()}"`);
    } else {
      offsetMs = Math.round(Number(mpegts[1]) / 90) - localMs;
    }
    // 移除该头所在行，避免其成为无时间行的块被静默丢弃
    body = headerRegion.replace(mapMatch[0], '') + restRegion;
    // HLS 分片直接拼接会带多份映射：只应用第一份必然错轴，明确报错而非静默产出错误时间轴。
    // 只统计「紧跟 WEBVTT 头行」的映射（分片边界形态），字幕文本里恰好以
    // X-TIMESTAMP-MAP= 开头的行不算——那是正文，不是偏移头
    const segMaps = restRegion.match(/^WEBVTT.*\nX-TIMESTAMP-MAP=/mg);
    if (segMaps) {
      errors.push(
        `检测到 ${segMaps.length + 1} 份 X-TIMESTAMP-MAP（HLS 分片拼接？），仅应用首份，后续句段时间轴可能偏移——请先合并为单文件再导入`
      );
    }
  }

  const { cues, errors: parseErrors } = parseGeneric(body, { expectHeader: true });

  // 应用时间基准偏移：先平移再校验——整条落在 0 之前的句段（负偏移超过其结束时间）
  // 丢弃并报错；跨越 0 点的句段仅把起点钳到 0（保持 endMs > startMs）
  let shiftedCues = cues;
  if (offsetMs !== 0) {
    const kept: typeof cues = [];
    let dropped = 0;
    for (const cue of cues) {
      const shiftedEnd = cue.endMs + offsetMs;
      if (shiftedEnd <= 0) {
        dropped++;
        continue;
      }
      cue.startMs = Math.max(0, cue.startMs + offsetMs);
      cue.endMs = shiftedEnd;
      kept.push(cue);
    }
    if (dropped > 0) {
      errors.push(`时间基准偏移 ${offsetMs}ms 使 ${dropped} 条句段整体落在 0 之前，已丢弃`);
    }
    // 丢弃后重新编号：index 保持 0 起连续（与函数 doc、Cue.index 注释及 SRT 路径一致），
    // 否则产生空洞（如 1、3），把 index 当数组下标使用的下游会与 cue 数组错位
    kept.forEach((cue, i) => {
      cue.index = i;
    });
    shiftedCues = kept;
  }

  return { cues: shiftedCues, errors: [...errors, ...parseErrors] };
}

/**
 * 将句段列表序列化为 WebVTT 文本
 * @param cues 句段列表
 * @param mode 输出模式：en 仅英文 / zh 仅中文（缺失回退英文）/ bilingual 双语
 * @returns VTT 全文（LF 换行）
 */
export function serializeVtt(
  cues: Cue[],
  mode: 'en' | 'zh' | 'bilingual' = 'en'
): string {
  // 该模式下无文本行的 cue 直接跳过：空块重新导入会被静默丢弃（与 serializeSrt 行为统一）
  const blocks = cues
    .filter((cue) => pickCueLines(cue, mode).length > 0)
    .map((cue, i) => {
      const timing = `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}`;
      const lines = pickCueLines(cue, mode);
      return `${i + 1}\n${timing}\n${lines.join('\n')}`;
    });
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;
}
