/**
 * 正则工具单源（web 端）
 *
 * 各页词高亮/挖空都要把用户可控文本（词元等）嵌进 RegExp 构造，转义规则
 * 必须单源——两处各写一份的话，新增元字符处理只会改一处。
 */

/**
 * 正则元字符转义（把字面文本安全嵌入 RegExp 构造）
 * @param s 原始文本
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
