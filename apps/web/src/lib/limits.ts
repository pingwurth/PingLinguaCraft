/**
 * 跨端共享的输入上限常量（客户端/服务端共用单源）
 *
 * 服务端领域模块（如 manualCard.ts 引 zod）不适合被客户端组件值导入——
 * 常量放这里保持客户端依赖面干净。
 */

/** 仿写短句长度上限（write-check 路由 400 闸与手册页 textarea maxLength 共用） */
export const WRITE_TEXT_MAX = 600;

/** 检索词长度上限（/api/search 服务端 400 闸与客户端防抖归一共用单源） */
export const SEARCH_QUERY_MAX = 100;

/** 材料分页 pageSize 上限（服务端钳制闸与案头今研首页请求共用单源） */
export const MATERIAL_PAGE_MAX = 100;

/** 材料分页缺省页大小（集内列表路由缺省/非法参数回落共用单源） */
export const MATERIAL_PAGE_DEFAULT = 20;

/** 材料集名长度上限（collections 两路由清洗闸与藏经阁立卷/编辑弹窗 maxLength 共用单源） */
export const COLLECTION_NAME_MAX = 40;
