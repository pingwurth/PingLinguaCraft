/**
 * 材料集文本字段清洗单源（服务端）
 *
 * POST /api/collections 与 PATCH /api/collections/[id] 共用：此前两路各自
 * 为政——POST 会 trim name 并对空名 400、trim description、空 cefrLevel 归
 * null，PATCH 却直拷 body 值，空名/纯空白简介/空梯级都能入库，同一份坏
 * 输入两端行为漂移。
 */

import { COLLECTION_NAME_MAX } from '@/lib/limits';

/** CEFR 梯级白名单（客户端选项不构成服务端约束：白名单外的值归一为 null，
 *  防直连 API 把任意字符串写进 cefr_level 并在卷卡「梯级 xx」处原样渲染） */
const CEFR_LEVELS = new Set(['A2', 'B1', 'B2', 'C1', 'C2']);

/** 清洗结果：patch 仅含请求体出现的字段（PATCH 语义：未出现不动；
 *  显式 null = 清空该字段——前端取消已设简介/梯级正是发 null） */
export interface CleanedCollectionText {
  patch: { name?: string; description?: string | null; cefrLevel?: string | null };
  /** 请求体带了 name 但清洗后为空（两路一律 400，与 POST 原口径一致） */
  nameInvalid: boolean;
  /** 请求体 name 超长（专属 400 提示，不与「不能为空」混报） */
  nameTooLong: boolean;
  /** 字段存在但类型不符（如 name 传数组/数字）：按 400 拒绝而非视同未出现
   *  ——静默无操作会让客户端序列化 bug 退化成「看似成功」 */
  typeInvalid: boolean;
}

/**
 * 清洗集卷文本字段：name 去空白 + 长度闸；description 去空白、空串/显式
 * null 归 null；cefrLevel 白名单归一（白名单外/显式 null 归 null）
 * @param body 原始请求体（字段存在但类型不符时置 typeInvalid，调用方 400）
 */
export function cleanCollectionTextFields(body: Record<string, unknown>): CleanedCollectionText {
  const patch: CleanedCollectionText['patch'] = {};
  let nameInvalid = false;
  let nameTooLong = false;
  let typeInvalid = false;
  if (body.name !== undefined) {
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) nameInvalid = true;
      else if (Array.from(name).length > COLLECTION_NAME_MAX) nameTooLong = true;
      else patch.name = name;
    } else if (body.name !== null) {
      typeInvalid = true;
    } else {
      nameInvalid = true; // name 显式 null：NOT NULL 列无处可落，按空名拒绝
    }
  }
  if (body.description !== undefined) {
    if (typeof body.description === 'string') patch.description = body.description.trim() || null;
    else if (body.description === null) patch.description = null;
    else typeInvalid = true;
  }
  if (body.cefrLevel !== undefined) {
    if (typeof body.cefrLevel === 'string') {
      const cefr = body.cefrLevel.trim().toUpperCase();
      patch.cefrLevel = CEFR_LEVELS.has(cefr) ? cefr : null;
    } else if (body.cefrLevel === null) {
      patch.cefrLevel = null;
    } else {
      typeInvalid = true;
    }
  }
  return { patch, nameInvalid, nameTooLong, typeInvalid };
}
