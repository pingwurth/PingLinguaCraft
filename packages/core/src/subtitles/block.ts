/**
 * 块状字幕共享基础（SRT 与 VTT 通用）
 *
 * 从原 srt.ts 抽出为独立模块，避免 VTT 反向依赖 SRT：
 * - ParseResult：解析结果类型（句段 + 逐块错误）
 * - parseGeneric：按空行分块的通用解析器（SRT/VTT 块结构同构）
 * - pickCueLines：序列化时按模式挑选文本行（两种格式行为统一）
 */

import { parseTimestamp } from './time';
import type { Cue } from '../types';

/** 字幕解析结果：成功解析的句段 + 逐块错误信息（不因个别畸形块整体失败） */
export interface ParseResult {
  cues: Cue[];
  errors: string[];
}

/**
 * 通用块状字幕解析器：SRT 与 VTT 共用
 * 按空行分块，每块内定位时间行（含 "-->"），其上为可选 id/序号，其下为文本。
 * @param text               字幕全文
 * @param opts.expectHeader  VTT 需要校验 "WEBVTT" 头
 */
export function parseGeneric(
  text: string,
  opts: { expectHeader: boolean }
): ParseResult {
  const errors: string[] = [];
  const cues: Cue[] = [];

  // 去 BOM、统一换行
  let normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  if (opts.expectHeader) {
    if (!/^WEBVTT/.test(normalized)) {
      return { cues, errors: ['缺少 WEBVTT 文件头'] };
    }
    // 去掉文件头及其后的元数据空行段
    normalized = normalized.replace(/^WEBVTT.*\n/, '');
  }

  // 按一个及以上空行分块；块号按原始顺序计（供错误信息定位，不受跳过块影响）
  const blocks = normalized.split(/\n{2,}/);
  let cueIndex = 0;

  blocks.forEach((block, blockNo) => {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return;

    // NOTE / STYLE / REGION 块跳过（VTT 专有块）。
    // 正则必须带词边界（后随空白或行尾）：规范允许任意非 "-->" 的 cue 标识符，
    // 若用 /^(NOTE|STYLE|REGION)/ 裸前缀匹配会把 NOTES / REGIONAL-intro 等
    // 合法标识符的句段整块静默丢弃。
    if (/^(NOTE|STYLE|REGION)(?=\s|$)/.test(lines[0]!)) return;

    // 定位时间行：可能首行是序号/ID
    const timingLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingLineIdx === -1) {
      // 无时间行的块：SRT 中常见于文件尾杂项，忽略但不报错
      return;
    }
    // 时间行必含 "-->"（findIndex 的匹配条件），split 必得 ≥2 段，无需长度判断；
    // 真正的非法（时间解析失败 / 倒置区间）由下方 parseTimestamp 与 endMs < startMs 校验
    const timingParts = lines[timingLineIdx]!.split('-->');
    const startMs = parseTimestamp(timingParts[0]!);
    // 结束时间去掉 VTT 附加设置（如 "align:start position:0%"）
    const endRaw = timingParts[1]!.trim().split(/\s+/)[0]!;
    const endMs = parseTimestamp(endRaw);
    if (startMs === null || endMs === null || endMs < startMs) {
      errors.push(`第 ${blockNo + 1} 块：时间非法 "${lines[timingLineIdx]!.trim()}"`);
      return;
    }
    const textLines = lines.slice(timingLineIdx + 1);
    if (textLines.length === 0) {
      // 空文本块跳过
      return;
    }
    // 双语导入启发：两行文本且第二行为中文时，按原文/译文拆分（供导入后人工确认）
    const { textEn, textZh } = splitBilingual(textLines);

    cues.push({
      index: cueIndex++,
      startMs,
      endMs,
      textEn,
      textZh,
    });
  });

  return { cues, errors };
}

/**
 * 双语行拆分启发式：文本两行且第二行以中文字符开头时视为「英文+中文」双语块
 * @param lines 文本行
 * @returns 拆出的英文与中文（未命中启发式时中文为 null）
 */
function splitBilingual(lines: string[]): { textEn: string; textZh: string | null } {
  const joined = lines.join('\n');
  if (lines.length === 2 && /^[一-鿿]/.test(lines[1]!.trim())) {
    return { textEn: lines[0]!.trim(), textZh: lines[1]!.trim() };
  }
  return { textEn: joined, textZh: null };
}

/**
 * 序列化时按模式挑选文本行（SRT/VTT 共用，行为统一）
 * zh 模式下中文缺失时回退英文：避免产出无文本行的空块（空块重新导入会被静默丢弃）
 * @param cue 句段
 * @param mode en 仅英文 / zh 仅中文（缺失回退英文）/ bilingual 双语
 * @returns 应写入字幕文件的文本行（已过滤空行）
 */
export function pickCueLines(cue: Cue, mode: 'en' | 'zh' | 'bilingual'): string[] {
  const en = cue.textEn.trim();
  const zh = (cue.textZh ?? '').trim();
  // 分支展开（项目规范：不使用链式三元），zh 缺中文回退英文避免产出空块
  if (mode === 'en') {
    return en ? [en] : [];
  }
  if (mode === 'zh') {
    if (zh) return [zh];
    return en ? [en] : [];
  }
  const out: string[] = [];
  if (en) out.push(en);
  if (zh) out.push(zh);
  return out;
}
