/**
 * API 路由参数防御（单一来源）
 *
 * 动态段数值 id 一律经 parseIdParam 解析：NaN/非整数/非正数返回 null，
 * 路由层转 400。此前约 30 个路由各自 `Number(id)` 不设防——非法 id 以 NaN
 * 进 SQL 匹配 0 行静默 200，或触发下游无谓的清理动作（存量 scan 出的
 * 40 条 high 同根因，规则已沉淀进 .opencodereview/rule.json）。
 */

/**
 * 解析动态路由的数值 id 参数
 * @param raw 路径参数原始值（undefined/null 容忍）
 * @returns 合法正整数返回其值，否则 null（调用方返回 400）
 */
export function parseIdParam(raw: string | undefined | null): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
