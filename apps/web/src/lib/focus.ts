/**
 * 模态焦点陷阱共用工具（客户端）
 *
 * ConfirmDialog 卡片与 MobileSearch 全屏浮层两个焦点陷阱共用单源——
 * 此前两份手抄选择器已在 disable 语义上漂移：一份不排禁用钮会把焦点
 * 递给不可聚焦元素，另一份排了则陷阱少元素。
 */

/** 「可聚焦元素」选择器（排禁用态与不可聚焦形态：hidden 输入、tabindex=-1
 *  ——原生可聚焦元素带 -1 时仍会经标签分支入选，成为不可达的首尾锚点让
 *  Tab 逃出陷阱，故每个分支都排；非空但不可聚焦的集合会让首尾锚点
 *  focus() 落空、Tab 循环失效） */
export const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  '[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex^="-"])',
].join(', ');
