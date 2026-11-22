/**
 * 模态焦点陷阱共用工具（客户端）
 *
 * ConfirmDialog 卡片与 MobileSearch 全屏浮层两个焦点陷阱共用单源——
 * 此前两份手抄选择器已在 disable 语义上漂移：一份不排禁用钮会把焦点
 * 递给不可聚焦元素，另一份排了则陷阱少元素。
 */

/** 「可聚焦元素」选择器（排禁用态：禁用的按钮/输入不进陷阱） */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
