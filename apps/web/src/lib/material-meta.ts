/**
 * 材料展示元数据单源（来源类型 / 字幕状态 → 图标 + 中文标签 + 色调）
 *
 * 案头今研首页、藏经阁与材料集详情页共用的映射，避免各页自行声明后漂移
 * （图标不一致 / 文案不一致 / 新增状态漏改一处）。
 */

/** 来源类型元数据表：key 为 materials.source_type（未知类型由调用方回退 audio） */
export const SOURCE_META: Record<string, { icon: string; label: string }> = {
  video: { icon: 'movie', label: '视频' },
  audio: { icon: 'headphones', label: '音频' },
  text: { icon: 'text_snippet', label: '文本' },
  link: { icon: 'link', label: '链接' },
};

/** 字幕状态元数据表：key 为 materials.subtitle_status（就绪竹青 / 解析中赭褐 / 失败破红 / 待处理弱化） */
export const SUBTITLE_STATUS_META: Record<string, { icon: string; label: string; tone: string }> = {
  ready: { icon: 'done_all', label: '双语已就绪', tone: 'text-shell-bamboo' },
  processing: { icon: 'autorenew', label: '解析中', tone: 'text-ochre' },
  failed: { icon: 'error', label: '解析失败', tone: 'text-destructive' },
  none: { icon: 'hourglass_empty', label: '待处理', tone: 'text-outline' },
};

/**
 * 取字幕状态展示元数据（未知状态回退「待处理」，调用处不必各写兜底）
 * @param status materials.subtitle_status 原值
 */
export function subtitleStatusMeta(status: string): { icon: string; label: string; tone: string } {
  return SUBTITLE_STATUS_META[status] ?? SUBTITLE_STATUS_META.none!;
}
