/**
 * 服务端 API 客户端（局域网 web 服务，Expo 端）
 *
 * 基址为内存态模块变量：App 重启后归零，需在设置屏重输（M5 骨架暂不做
 * 持久化，后续可接 AsyncStorage 记住上次地址）。
 * 响应解析与错误契约（{ error } → 抛错）复用 @pinglc/core 的
 * parseApiResponse，与 web 端同一实现；领域 DTO 类型同样来自 @pinglc/core
 * 单一来源（此处再导出，双端契约不再手工复制漂移）。
 */

import { jsonHeaders, parseApiResponse } from '@pinglc/core';

export type { Collection, MaterialListItem, CueDTO } from '@pinglc/core';

/** 请求超时（毫秒）：网络对目标地址丢包不回 RST 时 fetch 永不 settle，必须兜底 */
const REQUEST_TIMEOUT_MS = 8_000;

/** API 基址（运行时可被 setBaseUrl 更新） */
let baseUrl = '';

/**
 * 设置服务基址（如 http://192.168.1.10:3000）
 * @param url 基址（不带尾斜杠）
 */
export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}

/**
 * 当前基址（未设置时返回空，由 UI 引导填写）
 */
export function getBaseUrl(): string {
  return baseUrl;
}

/**
 * 通用请求：8 秒超时；超时/非 2xx 抛错（消息可展示）
 * @param path 接口路径（/api/…）
 * @param init fetch 参数
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error('未设置服务地址');
  // 手动 AbortController + 定时器（Hermes 无 AbortSignal.timeout）。
  // 调用方自带 signal 时桥接到内部控制器（外部取消同样中断请求），
  // 且不吞掉外部取消的 AbortError（只把「超时」翻译成人话）
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  const external = init?.signal;
  const onExternalAbort = () => ctrl.abort();
  if (external) {
    // 已中止的 signal 不会再触发 abort 事件——直接中止内部控制器
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onExternalAbort);
  }
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      // 头归一化（core 的 jsonHeaders）：Headers 实例/对象/元组均可，
      // FormData 体不设 Content-Type（boundary 由 fetch 生成）。
      // 注意 init.headers 不再原样透传——统一经归一化后交给 fetch
      headers: jsonHeaders(init?.body, init?.headers) as RequestInit['headers'],
    });
    return await parseApiResponse<T>(resp);
  } catch (e) {
    if (timedOut) {
      throw new Error(`连接超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请检查地址与网络`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}
