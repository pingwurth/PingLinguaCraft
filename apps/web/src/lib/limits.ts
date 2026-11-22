/**
 * 跨端共享的输入上限常量（客户端/服务端共用单源）
 *
 * 服务端领域模块（如 manualCard.ts 引 zod）不适合被客户端组件值导入——
 * 常量放这里保持客户端依赖面干净。
 */

/** 仿写短句长度上限（write-check 路由 400 闸与手册页 textarea maxLength 共用） */
export const WRITE_TEXT_MAX = 600;
