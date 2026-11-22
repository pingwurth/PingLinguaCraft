/**
 * 首页聚合查询的 queryKey 契约（运行时常量）
 *
 * ['home'] 是壳层/首页共享缓存的跨模块键（AppShell 统计与案头今研共用），
 * 任一处拼写漂移就会缓存静默不共享——全部调用点引用此常量。
 */

/** 首页聚合（/api/home）queryKey */
export const HOME_QUERY_KEY = ['home'] as const;
