/**
 * API 路由参数防御（单一来源）
 *
 * 动态段数值 id 一律经 parseIdParam 解析：NaN/非整数/非正数返回 null，
 * 路由层转 400。此前约 30 个路由各自 `Number(id)` 不设防——非法 id 以 NaN
 * 进 SQL 匹配 0 行静默 200，或触发下游无谓的清理动作（存量 scan 出的
 * 40 条 high 同根因，规则已沉淀进 .opencodereview/rule.json）。
 * JSON 请求体一律经 readJsonBody 读取：旧模式 `(await request.json()) as T`
 * 是纯编译期断言——非法 JSON 抛 SyntaxError 变 500，null/原始值让下游取属性
 * 抛 TypeError。
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

/**
 * 安全读取 JSON 请求体（解析守卫）
 * @param request Request 对象
 * @returns 合法 JSON 对象返回其值；非法 JSON / null / 非对象（原始值/数组）
 *          返回 null（调用方返回 400）
 */
export async function readJsonBody<T extends object>(request: Request): Promise<T | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as T;
}
