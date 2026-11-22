/**
 * 全局检索 DTO 类型（GET /api/search 响应）
 *
 * 供桌面顶栏全局检索（components/shell/TopBar）消费，
 * 与 API route 共享同一份类型来源，避免两处手写漂移。
 */

import type { MaterialSourceType, SubtitleStatus } from '@pinglc/core';

/** 检索命中 · 材料集（按卷名匹配） */
export interface SearchCollectionHit {
  /** 集卷 id（命中行跳 /collection/{id}） */
  id: number;
  /** 卷名 */
  name: string;
  /** 未删除材料数（结果行右侧展示「N 篇材料」） */
  materialCount: number;
}

/** 检索命中 · 材料（按标题匹配） */
export interface SearchMaterialHit {
  /** 材料 id（命中行跳 /material/{id}） */
  id: number;
  /** 材料标题 */
  title: string;
  /** 来源类型：video / audio / text / link（展示用 SOURCE_META 映射图标） */
  sourceType: MaterialSourceType;
  /** 字幕状态：none / processing / ready / failed（未就绪时结果行弱化提示） */
  subtitleStatus: SubtitleStatus;
  /** 所属集 id */
  collectionId: number;
  /** 所属集名 */
  collectionName: string;
}

/** GET /api/search?q= 响应：两组命中（材料集在前、材料在后） */
export interface SearchResults {
  /** 卷名命中的材料集 */
  collections: SearchCollectionHit[];
  /** 标题命中的材料 */
  materials: SearchMaterialHit[];
}
