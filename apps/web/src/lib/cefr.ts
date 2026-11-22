/**
 * CEFR 梯级枚举单源（客户端选择器与服务端清洗白名单共用）
 *
 * 此前两处手抄（藏经阁 CEFR_OPTIONS 的 value 集 / collection-input 的
 * Set 白名单）：UI 加档而白名单未同步时，携带新档位的 PATCH 会被静默
 * 归一成 null——返回 ok 却抹掉已存值。
 */

/** CEFR 梯级值（落库形态，大写） */
export const CEFR_LEVELS = ['A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** CEFR 梯级值类型 */
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/** 梯级白名单集合（服务端清洗判定用） */
export const CEFR_LEVEL_SET: ReadonlySet<string> = new Set(CEFR_LEVELS);
