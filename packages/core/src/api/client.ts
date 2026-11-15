/**
 * 共享 API 客户端内核（web 与 Expo 双端共用）
 *
 * fetch 本身由各端发起：web 端相对路径，mobile 端拼接 baseUrl 并加超时。
 * 内核承担：
 * - 响应解析 + 错误契约：JSON 解析、非 JSON 透传、非 2xx 一律抛 ApiError
 *   （服务端 { error } 字段优先，携带 HTTP 状态码）
 * - 请求头归一化 jsonHeaders：默认补 JSON Content-Type、FormData 体不设
 *   （multipart boundary 由 fetch 生成）、调用方头优先
 *
 * 类型纪律：不依赖 DOM lib / @types/node 的全局声明（core 的 tsconfig 仅
 * ES2022，此前 Headers/FormData 能过检靠的是 vitest 传递引入的 @types/node
 * 全局——依赖链一变即断）——一律结构化最小类型 + globalThis 取构造器，
 * 浏览器 / RN / Node≥18 运行时均内置这些构造器。
 */

/** API 错误（服务端 error 字段或网络异常文本，携带 HTTP 状态码） */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    // 显式置 name：日志 / RN 错误面板 / 消费方的 instanceof·name 判别才准确
    this.name = 'ApiError';
  }
}

/** 解析后的头集合最小形态（运行时的 Headers 实例天然满足；避免引入 DOM lib） */
export interface HeadersLike {
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  /** 遍历条目（无 Headers 全局的降级路径用；真 Headers 实例都有） */
  forEach?(callback: (value: string, key: string) => void): void;
}

/**
 * 头输入形态（对齐 DOM HeadersInit 的合法输入：Headers 实例 / 普通对象 /
 * [key, value][] 元组数组；core 不依赖 DOM lib，故自定义结构化类型）
 */
export type HeadersInput = HeadersLike | Array<[string, string]> | Record<string, string>;

/** globalThis 上可能存在的 Headers 构造器（双端运行时均有；类型上不依赖全局声明） */
type HeadersCtor = new (init?: HeadersInput) => HeadersLike;
const HeadersCtor = (globalThis as { Headers?: HeadersCtor }).Headers;

/** globalThis 上可能存在的 FormData 构造器（仅用于体类型判定） */
type FormDataCtor = new () => unknown;
const FormDataCtor = (globalThis as { FormData?: FormDataCtor }).FormData;

/**
 * 合并请求头：默认补 Content-Type: application/json；FormData 体不设
 * （multipart boundary 由 fetch 生成，覆盖会破坏上传）；调用方头优先
 * （Headers 实例 / 普通对象 / 元组数组均接受——对象展开合并不认识 Headers，
 * 会把调用方头静默丢弃）。
 * Headers 构造器不存在时降级为普通对象（条目经 forEach/元组/对象枚举取得；
 * 不保证 Headers 的大小写不敏感语义——现实双端运行时都走 Headers 分支）。
 * @param body    请求体（判断是否 FormData，可空）
 * @param headers 调用方头（可空）
 */
export function jsonHeaders(body: unknown, headers?: HeadersInput): HeadersLike {
  const isForm = FormDataCtor != null && body instanceof FormDataCtor;
  const applyDefault = (h: HeadersLike) => {
    if (!isForm && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
    return h;
  };
  if (HeadersCtor) {
    return applyDefault(new HeadersCtor(headers));
  }
  // 降级：普通对象实现 HeadersLike（大小写敏感，仅极旧运行时会走到）
  const flat: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) flat[k] = v;
  } else if (headers && typeof (headers as HeadersLike).forEach === 'function') {
    (headers as HeadersLike).forEach!((v, k) => {
      flat[k] = v;
    });
  } else if (headers) {
    Object.assign(flat, headers as Record<string, string>);
  }
  return applyDefault({
    get: (n) => flat[n] ?? null,
    set: (n, v) => {
      flat[n] = v;
    },
    has: (n) => flat[n] !== undefined,
    forEach: (cb) => {
      for (const [k, v] of Object.entries(flat)) cb(v, k);
    },
  });
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
