/**
 * 前端 API 客户端：类型化 fetch 封装（页面与 react-query 共用）
 *
 * 约定：错误响应 { error } → 抛 ApiError（消息可直接展示）。
 * 响应解析与错误契约在 @pinglc/core 的 parseApiResponse（与 Expo 端共享），
 * DTO 类型同样来自 @pinglc/core —— 双端单一来源，此处再导出保持既有
 * `@/lib/api` 引用面稳定。
 */

import { ApiError, jsonHeaders, parseApiResponse } from '@pinglc/core';

export { ApiError };
export type {
  Collection,
  MaterialListItem,
  MaterialDetail,
  CueDTO,
  ProgressDTO,
  JobDTO,
  ProviderDTO,
  EngineInfo,
} from '@pinglc/core';

/**
 * 通用请求封装
 * @param path 路径（/api/…）
 * @param init fetch 参数（method/body 等；headers 经 jsonHeaders 归一化——
 *             Headers 实例/对象/元组均可，FormData 体不覆盖 boundary）
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: jsonHeaders(init?.body, init?.headers) as RequestInit['headers'],
  });
  return parseApiResponse<T>(resp);
}
