/**
 * 收藏快照写入的单一来源（服务端）
 *
 * 收藏的两条创建路径——手动收藏（POST /api/favorites）与「AI 解析并收藏」
 * （POST /api/cues/[id]/analyze）——insert 时都必须展开本 helper 的快照字段：
 * cue 消亡（重 STT/重导入的删旧插新、单句删除）后 cueId 置空，收藏展示
 * 完全依赖此时的快照。此前各路由手写字段清单，漏一列即该路径收藏退化为
 * 空句（存量审查拦下过：analyze 路径就是漏写的那条）。
 */

/**
 * 取收藏 insert values 的快照字段（展开进 values 即可）
 * @param cue 已查得的 cue 行（至少含 materialId/textEn/textZh）
 * @returns 可直接 spread 的三个快照列
 */
export function favoriteSnapshotOf(cue: {
  materialId: number;
  textEn: string;
  textZh: string | null;
}): { materialId: number; textEn: string; textZh: string | null } {
  return { materialId: cue.materialId, textEn: cue.textEn, textZh: cue.textZh };
}
