/**
 * 材料来源类型 → 展示元数据（图标 + 中文标签）
 *
 * 首页流动动向与材料集详情页共用的单源映射，避免两处各自声明后漂移
 * （图标不一致 / 新增来源类型漏改一处）。
 */

/** 来源类型元数据表：key 为 materials.source_type（未知类型由调用方回退 audio） */
export const SOURCE_META: Record<string, { icon: string; label: string }> = {
  video: { icon: 'movie', label: '视频' },
  audio: { icon: 'headphones', label: '音频' },
  text: { icon: 'text_snippet', label: '文本' },
  link: { icon: 'link', label: '链接' },
};
