/**
 * 首页聚合数据类型（GET /api/home）
 *
 * 首页一次请求拿全：统计卡 / 续研书签 / 流转动向 / 集卷列表（含研读进度）。
 * 仅 web 侧使用；将来移动端（apps/mobile）复用时再上移 @pinglc/core。
 */

/** 首页统计卡数据（设计稿 _10 四格纸墨韵数） */
export interface HomeStats {
  /** 材料集（卷）数 */
  collectionCount: number;
  /** 未删除的材料总数 */
  materialCount: number;
  /** 材料总时长（毫秒） */
  totalDurationMs: number;
  /** 已听过的句段总数（learning_progress.listenedMask 位图置位数之和） */
  studiedSentenceCount: number;
  /** 生词总数 */
  wordCount: number;
}

/** 续研书签（最近停留的学习进度；无任何实质进度时为 null） */
export interface HomeResumePoint {
  /** 材料 id（续研入口跳 /material/{id}） */
  materialId: number;
  /** 材料标题 */
  materialTitle: string;
  /** 所属集 id */
  collectionId: number;
  /** 所属集名 */
  collectionName: string;
  /** 已听到的最大句序号（0 起） */
  maxCueIndex: number;
  /** 材料总句数 */
  cueCount: number;
  /** 研读进度百分比 0~100 */
  progressPct: number;
  /** 停留句的英文原文（书签引文） */
  lastCueText: string;
  /** 最近学习时间（epoch 毫秒） */
  updatedAt: number;
}

/** 流转动向条目（最近活跃的材料，设计稿 _10 列表行） */
export interface HomeRecentMaterial {
  /** 材料 id（行点击跳 /material/{id}） */
  materialId: number;
  /** 材料标题 */
  title: string;
  /** 来源类型：audio / video / text / link */
  sourceType: string;
  /** 媒体时长（毫秒；文本导入为 null） */
  mediaDurationMs: number | null;
  /** 句数（字幕就绪后统计） */
  sentenceCount: number | null;
  /** 去重词数 */
  uniqueWordCount: number | null;
  /** 字幕状态：none / processing / ready / failed */
  subtitleStatus: 'none' | 'processing' | 'ready' | 'failed';
  /** 所属集 id */
  collectionId: number;
  /** 所属集名 */
  collectionName: string;
  /** 学习进度最大句序号（无进度为 null） */
  maxCueIndex: number | null;
  /** 研读进度百分比 0~100 */
  progressPct: number;
  /** 最近活跃时间（epoch 毫秒；学习时间与材料更新时间取大） */
  activityAt: number;
}

/** 集卷卡数据（集合统计 + 研读进度聚合） */
export interface HomeCollection {
  id: number;
  name: string;
  description: string | null;
  /** 封面（预设纹理 id / 装帧图路径；目前恒空，前端以卷名首字活字代之） */
  cover: string | null;
  /** CEFR 等级（可空） */
  cefrLevel: string | null;
  /** 未删除材料数 */
  materialCount: number;
  /** 材料总时长（毫秒） */
  totalDurationMs: number;
  /** 集内句数合计（移动卡「N 篇材料 · M 句」用） */
  sentenceCount: number;
  /** 研读进度百分比 0~100（听句数/总句数聚合） */
  progressPct: number;
  /** 最近研习时间（epoch 毫秒；从未研习为 null） */
  lastStudiedAt: number | null;
}

/** GET /api/home 响应：首页全量聚合 */
export interface HomeData {
  stats: HomeStats;
  resume: HomeResumePoint | null;
  recent: HomeRecentMaterial[];
  collections: HomeCollection[];
}
