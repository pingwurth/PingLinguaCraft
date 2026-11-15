/**
 * 共享 API 客户端内核（web 与 Expo 双端共用）
 *
 * fetch 本身由各端发起：web 端相对路径（含 FormData 分支），mobile 端拼接
 * baseUrl 并加超时。内核只承担「响应解析 + 错误契约」：
 * - 响应体为 JSON 时解析；非 JSON 成功响应（如字幕导出）透传文本
 * - 非 2xx 一律抛 ApiError（服务端 { error } 字段优先，携带 HTTP 状态码）
 * 纯 TS、零依赖（fetch 为双端全局），core 纪律不受影响。
 */

/** API 错误（服务端 error 字段或网络异常文本，携带 HTTP 状态码） */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

/** parseApiResponse 需要的最小 Response 形态（结构化类型：不绑定 DOM lib，双端可用） */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  /** 读取响应体文本 */
  text(): Promise<string>;
}

/**
 * 解析 fetch Response：非 2xx 抛 ApiError；空体/非 JSON 成功响应透传文本
 * @param resp fetch 响应（结构化最小形态即可）
 * @returns 解析后的 JSON（或透传文本）
 */
export async function parseApiResponse<T>(resp: FetchResponseLike): Promise<T> {
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（如字幕导出）直接透传文本 */
    if (!resp.ok) throw new ApiError(`请求失败 ${resp.status}`, resp.status);
    return text as unknown as T;
  }
  if (!resp.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `请求失败 ${resp.status}`;
    throw new ApiError(msg, resp.status);
  }
  return data as T;
}
