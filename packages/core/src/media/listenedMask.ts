/**
 * 听过位图统计（学习进度「听过一遍」复核的单一口径）
 *
 * 客户端逐句置位（第 i 句听过 → 第 i 位置 1，低位在前的位图），服务端
 * 据此复核闯关解锁是否成立（不信任客户端单方面声明）。双端共享：客户端
 * 本地预判（如 UI 提示）与服务端复核必须同一实现，否则口径漂移。
 */

/**
 * 统计位图前 total 位的置位数（popcount 截断版）
 * @param mask  位图字节（第 i 句对应第 i 位，低位在前）
 * @param total 句段总数：只统计前 total 位，超出部分按客户端脏数据忽略
 * @returns 置位总数（0 ≤ n ≤ total）
 */
export function countListenedBits(mask: Uint8Array, total: number): number {
  let bits = 0;
  let seen = 0;
  for (const byte of mask) {
    for (let b = 0; b < 8 && seen < total; b++, seen++) {
      bits += (byte >> b) & 1;
    }
  }
  return bits;
}
