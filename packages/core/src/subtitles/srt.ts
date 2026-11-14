/**
 * SRT 字幕文件的解析与序列化
 *
 * 支持：CRLF/LF 换行、BOM 头、缺失序号行、畸形块跳过（收集错误）。
 * 序列化支持 en / zh / 双语三种模式（双语 = 英文行 + 中文行）。
 * 通用块解析器与文本行挑选在 block.ts（与 VTT 共享）。
 */

import { formatTimestamp } from './time';
import { parseGeneric, pickCueLines } from './block';
import type { ParseResult } from './block';
import type { Cue } from '../types';

/**
 * 解析 SRT 字幕文本为句段数组
 * @param text SRT 文件全文
 * @returns 句段列表（index 按 0 起重新编号）与错误信息列表
 */
export function parseSrt(text: string): ParseResult {
  return parseGeneric(text, { expectHeader: false });
}

/**
 * 将句段列表序列化为 SRT 文本
 * @param cues 句段列表
 * @param mode 输出模式：en 仅英文 / zh 仅中文（缺失回退英文）/ bilingual 双语（英文行+中文行）
 * @returns SRT 全文（LF 换行，结尾带空行便于拼接）
 */
export function serializeSrt(
  cues: Cue[],
  mode: 'en' | 'zh' | 'bilingual' = 'en'
): string {
  // 该模式下无文本行的 cue 直接跳过：空块重新导入会被静默丢弃，
  // 与其导出后丢句，不如导出时就排除（半译数据 en 模式导出的典型场景）
  const blocks = cues
    .filter((cue) => pickCueLines(cue, mode).length > 0)
    .map((cue, i) => {
      const timing = `${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}`;
      const lines = pickCueLines(cue, mode);
      return `${i + 1}\n${timing}\n${lines.join('\n')}`;
    });
  return blocks.join('\n\n') + (blocks.length > 0 ? '\n\n' : '');
}
