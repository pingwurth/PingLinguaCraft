/**
 * 句子听写比对（全句听写模式的判分核心）
 *
 * 将用户输入与目标句逐词对齐，每个词标记状态：
 * - correct 完全匹配（大小写/标点宽容）
 * - typo     近似匹配（编辑距离 1，视为拼写小错）
 * - wrong    完全不对
 * - missing  目标有而用户漏写
 * - extra    用户多写
 * 对齐用简单 LCS（目标句长度有限，O(n·m) 足够）。
 */

import { extractWords, normalizeWord } from './tokenize';

/** 单词判定结果 */
export type WordDiffStatus = 'correct' | 'typo' | 'wrong' | 'missing' | 'extra';

/** 单个词的比对项 */
export interface WordDiffItem {
  /** 目标词（missing 时为空串） */
  target: string;
  /** 用户输入词（extra/missing 时可能为空串） */
  typed: string;
  status: WordDiffStatus;
}

/** 整句比对结果 */
export interface SentenceDiff {
  items: WordDiffItem[];
  /** 正确率（correct=1, typo=0.5 计权） */
  score: number;
  /** 是否全对（含 typo 视为通过？——严格模式由调用方判定，这里给出 exact 布尔） */
  exact: boolean;
}

/**
 * 两词是否近似（编辑距离 ≤1）：交换字母、漏/多/错一个字符均算 typo
 * @param a 词 a（已归一化）
 * @param b 词 b（已归一化）
 */
function isNear(a: string, b: string): boolean {
  if (a === b) return true;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > 1) return false;
  // 编辑距离 1 的经典判定
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return true; // 尾部残余 ≤1 字符由 lenDiff 保证
}

/**
 * 全句听写比对
 * @param targetText 目标句原文
 * @param typedText  用户输入
 * @returns 逐词比对结果与得分
 */
export function diffSentence(targetText: string, typedText: string): SentenceDiff {
  const target = extractWords(targetText).map(normalizeWord);
  const typed = extractWords(typedText).map(normalizeWord);
  const n = target.length;
  const m = typed.length;

  // LCS 表（匹配 = 完全相等或近似；近似优先级低，先算严格 LCS）
  // dp[i][j] = target 前 i 个与 typed 前 j 个的最大匹配数
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const near = isNear(target[i - 1]!, typed[j - 1]!);
      dp[i]![j] = Math.max(
        dp[i - 1]![j]!,
        dp[i]![j - 1]!,
        dp[i - 1]![j - 1]! + (near ? 1 : 0)
      );
    }
  }

  // 回溯生成比对项
  const items: WordDiffItem[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && isNear(target[i - 1]!, typed[j - 1]!) && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
      const t = target[i - 1]!;
      const u = typed[j - 1]!;
      items.unshift({
        target: t,
        typed: u,
        status: t === u ? 'correct' : 'typo',
      });
      i--;
      j--;
    } else if (i > 0 && dp[i]![j] === dp[i - 1]![j]) {
      items.unshift({ target: target[i - 1]!, typed: '', status: 'missing' });
      i--;
    } else if (j > 0) {
      items.unshift({ target: '', typed: typed[j - 1]!, status: 'extra' });
      j--;
    } else {
      break;
    }
  }

  const correctCount = items.filter((x) => x.status === 'correct').length;
  const typoCount = items.filter((x) => x.status === 'typo').length;
  const extraCount = items.filter((x) => x.status === 'extra').length;
  // 分母含多写的词：「正确句 + 垃圾词」不得满分（extra 同样污染得分）
  const total = Math.max(1, n + extraCount);
  const score = Math.min(1, (correctCount + typoCount * 0.5) / total);
  return {
    items,
    score: Math.round(score * 100) / 100,
    exact: n === m && correctCount === n,
  };
}
