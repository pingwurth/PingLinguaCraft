/**
 * 研读进度口径单源（服务端）：百分比换算 + 句数兜底/无位图估算助手
 *
 * cueCountsFor / estimateHeardNoMask 被 /api/home（分子分母/resume/近况）与
 * /api/collections/[id]/materials（逐篇进度）共同引用——各路由手抄副本正是
 * 「同一材料在不同界面呈现两个百分比」的漂移源。
 */

import { sql, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cues } from '@/lib/db/schema';

/**
 * 听句数 → 进度百分比（heard/total 四舍五入，上界 100；总句数为 0 时恒 0）
 * @param heard 已听句数（countListenedBits 位图口径，跳句不计）
 * @param total 总句数
 */
export function progressPct(heard: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((heard / total) * 100));
}

/**
 * 批量现数句段（sentence_count 缺失的老材料分母兜底）：一条分组查询取多材料
 * cues 计数
 * @param db  数据库连接
 * @param ids 材料 id 列表
 */
export function cueCountsFor(db: ReturnType<typeof getDb>, ids: number[]): Map<number, number> {
  const map = new Map<number, number>();
  if (ids.length === 0) return map;
  for (const r of db
    .select({ materialId: cues.materialId, n: sql<number>`count(*)` })
    .from(cues)
    .where(inArray(cues.materialId, ids))
    .groupBy(cues.materialId)
    .all()) {
    map.set(r.materialId, r.n);
  }
  return map;
}
/**
 * 无位图行的听句估算（位图机制之前的存量进度）：按 maxCueIndex+1 封顶句数。
 * /api/home（按卷聚合 / resume 书签 / 案头近况）与 /api/collections/[id]/materials
 * 多处同口径调用——此前各路由内联一份形态各异，正是同一材料在不同卡片上
 * 0% 与 >0% 打架的漂移源
 * @param maxCueIndex 库中 max_cue_index（null=无进度行/未知；-1=未观测到句位）
 * @param total       总句数
 */
export function estimateHeardNoMask(maxCueIndex: number | null, total: number): number {
  return maxCueIndex == null || maxCueIndex < 0 || total <= 0 ? 0 : Math.min(maxCueIndex + 1, total);
}
