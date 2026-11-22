/**
 * 研读进度口径单源（服务端）：百分比换算
 *
 * learning_progress.listened_mask 为逐句听过位图（bit i = 第 i 句听过）。
 * 位图计数统一走 @pinglc/core 的 countListenedBits（按句数截断的 popcount，
 * 双端共享）；此前本文件另有一份不截断的 popcount，已删——两份实现正是
 * 此文件要消除的漂移源。
 */

/**
 * 听句数 → 进度百分比（heard/total 四舍五入，上界 100；总句数为 0 时恒 0）
 * @param heard 已听句数（countListenedBits 位图口径，跳句不计）
 * @param total 总句数
 */
export function progressPct(heard: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((heard / total) * 100));
}
