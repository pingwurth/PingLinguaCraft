/**
 * STT 词流分句器
 *
 * faster-whisper 的 VAD 分段 ≠ 句子边界，需要将词级时间戳流重新聚合为句段（cue）：
 * 1. 句末标点启发：词以 . ! ? … 结尾，且非缩写词，且下一词以大写/引号/括号开头 → 断句
 * 2. 守卫：小数（3.14）、编号（1. 后跟数字）不触发断句
 * 3. 上限保险：超过 maxWords（默认 30 词）或 maxDurationMs（默认 15 秒）强制断句
 * 4. 时间轴整理：句首前移 startPadMs（默认 80ms）、句尾后延 endPadMs（默认 150ms），
 *    相邻重叠时优先回缩前句尾 padding（padding 是装饰、词是数据，绝不丢词），
 *    极端钳制下跨界词只把起点钳入所属句区间（保持 s ≤ e，词表与文本永不失配）
 */

import type { WordTiming } from '../types';

/**
 * 已知缩写词词典（小写、不带结尾点）：
 * 这些词虽以句点结尾，但不应触发断句（Mr. Smith / e.g. a cat / U.S. government）
 * 注意：'no'（No. = numero 缩写）刻意不收录——普通单词 no. 的使用频率远高于缩写，
 * 收录会导致 "I said no. Then we left." 永不断句。
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'e.g', 'i.e', 'u.s', 'u.k', 'fig', 'approx', 'dept', 'inc', 'ltd',
  'co', 'al', 'cf', 'ca', 'vol', 'ed', 'pp',
]);

/** 分句可配置参数 */
export interface SegmentOptions {
  /** 单句最大词数，超过强制断句（默认 30） */
  maxWords?: number;
  /** 单句最大时长毫秒，超过强制断句（默认 15000） */
  maxDurationMs?: number;
  /** 句首时间前移量毫秒（默认 80） */
  startPadMs?: number;
  /** 句尾时间后延量毫秒（默认 150） */
  endPadMs?: number;
}

/** 分句产物：一个句段（含原文与词级时间戳） */
export interface SegmentedCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  words: WordTiming[];
}

/**
 * 判断某词是否为「句末词」（其后应断句）
 * @param word      当前词
 * @param nextWord  下一词（最后一个词时传 null）
 * @returns 是否应在该词后断句
 */
function isSentenceEnd(word: string, nextWord: string | null): boolean {
  // 无句末标点，不断句
  if (!/[.!?…]["'”’)]?$/.test(word)) return false;
  const bare = word.replace(/[.!?…]["'”’)]?$/, '').toLowerCase();
  // 缩写词（Mr. / e.g. / U.S.）不断句
  if (ABBREVIATIONS.has(bare)) return false;
  // 最后一个词：必然断句
  if (nextWord === null) return true;
  // 编号守卫：句点后跟数字（"1. 2. 3." 列表场景）不断句
  if (/^\d/.test(nextWord)) return false;
  // 下一词以大写字母、引号或括号开头 → 断句；小写开头视为误判标点
  return /^[A-Z“"(‘']/.test(nextWord);
}

/**
 * 将 STT 词级时间戳流重新分句为句段列表
 * @param words 词级时间戳数组（须按时间升序）
 * @param opts  分句参数（可选）
 * @returns 句段数组（index 从 0 起，时间已做 padding 与相邻钳制）
 */
export function segmentWords(
  words: WordTiming[],
  opts: SegmentOptions = {}
): SegmentedCue[] {
  const maxWords = opts.maxWords ?? 30;
  const maxDurationMs = opts.maxDurationMs ?? 15_000;
  const startPadMs = opts.startPadMs ?? 80;
  const endPadMs = opts.endPadMs ?? 150;

  if (words.length === 0) return [];

  // 第一步：按句末启发切分为词组
  const groups: WordTiming[][] = [];
  let current: WordTiming[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    current.push(w);
    const next = i + 1 < words.length ? words[i + 1]! : null;
    const groupStartSec = current[0]!.s;
    const groupDurMs = (w.e - groupStartSec) * 1000;
    // 句末启发 或 超长上限（词数/时长）时断句（注意传下一词的文本而非对象）
    if (
      isSentenceEnd(w.w, next ? next.w : null) ||
      current.length >= maxWords ||
      groupDurMs >= maxDurationMs
    ) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  // 第二步：词组 → 句段，应用 padding
  const cues: SegmentedCue[] = groups.map((g, i) => {
    const first = g[0]!;
    const last = g[g.length - 1]!;
    return {
      index: i,
      startMs: Math.max(0, Math.round(first.s * 1000 - startPadMs)),
      endMs: Math.round(last.e * 1000 + endPadMs),
      text: g.map((w) => w.w).join(' '),
      words: g,
    };
  });

  // 第三步：相邻钳制（不允许重叠，且保证 start < end 至少差 1ms）
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (i > 0) {
      const prev = cues[i - 1]!;
      if (cue.startMs < prev.endMs) {
        // 前句尾 padding（endPadMs）吞进本句首词时，优先回缩前句 endMs（牺牲装饰性
        // padding）而不是丢弃本句的词——丢词会静默丢失文本（点词定位/生词去重统计
        // 依赖完整词表），极端情况下整句词被清空还会使下方 words[last] 越界崩溃。
        // 回缩地板同时含前句末词终点：STT 词流自身可能轻微重叠（本句首词起点 <
        // 前句末词终点），此时宁可保留两句重叠也不把前句的词挤出区间，
        // 本句越界的词由下方钳制兜底。
        const firstStartMs = Math.round(cue.words[0]!.s * 1000);
        const prevLastEndMs = Math.round(prev.words[prev.words.length - 1]!.e * 1000);
        if (prev.endMs > firstStartMs) {
          prev.endMs = Math.max(prev.startMs + 1, prevLastEndMs, firstStartMs);
        }
        cue.startMs = prev.endMs;
        // 防御：连环钳制的极端情况下词起点仍早于句起点时，只把起点钳进区间
        // （保词不丢，保持 s ≤ e；卡拉OK高亮/点词定位/跟读评分窗口依赖此不变式）
        const startSec = cue.startMs / 1000;
        cue.words = cue.words.map((wd) =>
          wd.s < startSec ? { ...wd, s: startSec, e: Math.max(wd.e, startSec) } : wd
        );
      }
    }
    if (cue.endMs <= cue.startMs) cue.endMs = cue.startMs + 1;
    // 防御：词时间戳超出句尾时保底外延（安全访问，words 非空由构造保证，此处双保险）
    const last = cue.words[cue.words.length - 1];
    if (last) {
      const lastEndMs = Math.round(last.e * 1000);
      if (lastEndMs > cue.endMs) cue.endMs = lastEndMs;
    }
  }

  return cues;
}
