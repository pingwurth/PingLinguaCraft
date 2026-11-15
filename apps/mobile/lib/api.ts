/**
 * 服务端 API 客户端（局域网 web 服务）
 *
 * BASE_URL 解析顺序：expo-runtime 全局 __PINGLC_BASE_URL__（App 首屏可写入）→
 * 默认 http://<本机局域网 IP>:3000 估摸值（启动页提供设置输入覆盖）。
 */

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
 * 通用请求：非 2xx 抛错（消息可展示）
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error('未设置服务地址');
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await resp.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!resp.ok) {
    throw new Error((data as { error?: string } | null)?.error ?? `请求失败 ${resp.status}`);
  }
  return data as T;
}

/* ---------- 领域类型（@pinglc/core 的纯数据形态直用） ---------- */

export interface Collection {
  id: number;
  name: string;
  materialCount: number;
}

export interface MaterialListItem {
  id: number;
  title: string;
  sourceType: string;
  subtitleStatus: string;
  sentenceCount: number | null;
}

export interface CueDTO {
  id: number;
  index: number;
  startMs: number;
  endMs: number;
  textEn: string;
  textZh: string | null;
}
