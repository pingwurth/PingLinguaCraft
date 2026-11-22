/**
 * 研读进度口径单源（服务端）：位图听句计数与百分比
 *
 * learning_progress.listened_mask 为逐句听过位图（bit i = 第 i 句听过）。
 * 此前 popcount / progressPct 只在 /api/home 内联；材料列表接口
 * （/api/collections/[id]/materials）也要按材料回填同口径进度（案头今研
 * 首页的逐篇进度条），抽出到此避免两处口径漂移（跳句是否计数、百分比取整）。
 */

/**
 * 位图 popcount：数 listened_mask（逐句听过位图，bit i = 第 i 句听过）的置位数
 * @param buf 位图 BLOB（better-sqlite3 返回 Buffer；空为 null）
 */
export function popcount(buf: Buffer | null): number {
  if (!buf) return 0;
  let n = 0;
  for (const byte of buf) {
    // Brian Kernighan 算法：每次清最低置位位
    let x = byte;
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

/**
 * 听句数 → 进度百分比（heard/total 四舍五入，上界 100；总句数为 0 时恒 0）
 * @param heard 已听句数（listened_mask 位图置位数口径，跳句不计）
 * @param total 总句数
 */
export function progressPct(heard: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((heard / total) * 100));
}
