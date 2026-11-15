/**
 * 数据库 Schema（Drizzle ORM / SQLite）
 *
 * 单用户自托管：所有表预留 user_id（默认 1），便于未来迁移为多用户。
 * 库文件位于 ~/.pinglc/pinglc.db。
 * 表结构对应计划文档 §3：collections → materials → cues 为核心链路；
 * words/srs/favorites 承载学习资产；jobs/provider_profiles 支撑任务管线与 AI 能力路由。
 */

import { sqliteTable, text, integer, real, blob, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

/** 通用约定：主键自增 id；created_at/updated_at 为 epoch 毫秒 */
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
};

/* ---------------------------------------------------------------------------
 * 材料集（藏经阁的「卷」）—— 需求 19：首页即材料集汇聚地
 * ------------------------------------------------------------------------- */
export const collections = sqliteTable(
  'collections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** 集名（如「卷一 · 乔布斯典籍演说」） */
    name: text('name').notNull(),
    /** 描述 */
    description: text('description'),
    /** 封面：预设纹理 id 或 AI 生成的装帧图路径 */
    cover: text('cover'),
    /** CEFR 等级阶梯（设计稿 _17：A2~C2，可空） */
    cefrLevel: text('cefr_level'),
    /** AI 侍读深度预设：fast / standard / deep */
    aiDepthPreset: text('ai_depth_preset'),
    /** 手动排序权重 */
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('idx_collections_user').on(t.userId)]
);

/* ---------------------------------------------------------------------------
 * 材料（卷内的一篇音频/视频/文本）
 * ------------------------------------------------------------------------- */
export const materials = sqliteTable(
  'materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    /** 来源类型：本地音频 / 本地视频 / 文本导入 / 链接下载 */
    sourceType: text('source_type').notNull(), // 'audio' | 'video' | 'text' | 'link'
    /** 链接导入时的原始 URL */
    sourceUrl: text('source_url'),
    /** 媒体文件路径（相对 ~/.pinglc/media 的路径） */
    mediaPath: text('media_path'),
    mediaMime: text('media_mime'),
    mediaDurationMs: integer('media_duration_ms'),
    mediaSizeBytes: integer('media_size_bytes'),
    /** 波形峰值数据文件路径（JSON，2000 桶） */
    peaksPath: text('peaks_path'),
    /** 字幕就绪状态：none → processing → ready / failed */
    subtitleStatus: text('subtitle_status').notNull().default('none'),
    /** 需求 5：句子数（字幕 ready 时统计） */
    sentenceCount: integer('sentence_count'),
    /** 需求 5：去重单词数 */
    uniqueWordCount: integer('unique_word_count'),
    /** ffprobe / yt-dlp 元数据 JSON */
    metadataJson: text('metadata_json'),
    /** 软删除时间戳 */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    index('idx_materials_collection').on(t.collectionId),
    index('idx_materials_status').on(t.subtitleStatus),
  ]
);

/* ---------------------------------------------------------------------------
 * 字幕句段（cue）—— 播放页一切功能的核心数据
 * ------------------------------------------------------------------------- */
export const cues = sqliteTable(
  'cues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id, { onDelete: 'cascade' }),
    /** 句序号（材料内唯一，从 0 开始；插入/删除时事务性重排） */
    index: integer('index').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    /** 英文原文 */
    textEn: text('text_en').notNull(),
    /** 中文译文 */
    textZh: text('text_zh'),
    /** 本句译文由哪个 provider 产出（溯源） */
    translationProvider: text('translation_provider'),
    /** STT 平均置信度（0~1） */
    sttConfidence: real('stt_confidence'),
    /** 词级时间戳 JSON：[{w,s,e,p}]（卡拉OK高亮/点词/跟读评分） */
    wordsJson: text('words_json'),
    /** 是否人工编辑过（工坊纠错后置位） */
    isEdited: integer('is_edited', { mode: 'boolean' }).notNull().default(false),
    /** 需求 8：句子笔记（Markdown） */
    noteMd: text('note_md'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_cues_material_index').on(t.materialId, t.index),
    index('idx_cues_material').on(t.materialId),
  ]
);

/* ---------------------------------------------------------------------------
 * 生词本与生词 —— 需求 14：多本、自定义、笔记、AI 笔记
 * ------------------------------------------------------------------------- */
export const wordBooks = sqliteTable(
  'word_books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('uq_word_books_name').on(t.userId, t.name)]
);

export const words = sqliteTable(
  'words',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    wordBookId: integer('word_book_id')
      .notNull()
      .references(() => wordBooks.id, { onDelete: 'cascade' }),
    /** 归一化词条（小写、撇号归一），查重键 */
    lemma: text('lemma').notNull(),
    /** 展示形态（保留首次收录时的原文形态） */
    displayForm: text('display_form').notNull(),
    /** 英式音标（AI 生成） */
    phoneticUk: text('phonetic_uk'),
    /** 美式音标 */
    phoneticUs: text('phonetic_us'),
    /** 溯源：收录时所在的句段 */
    originCueId: integer('origin_cue_id').references(() => cues.id, { onDelete: 'set null' }),
    originMaterialId: integer('origin_material_id').references(() => materials.id, {
      onDelete: 'set null',
    }),
    /** 用户笔记（Markdown 编辑+预览） */
    noteMd: text('note_md'),
    /** AI 生成笔记（Markdown）与状态：none / pending / ready / failed */
    aiNoteMd: text('ai_note_md'),
    aiNoteStatus: text('ai_note_status').notNull().default('none'),
    aiNoteProvider: text('ai_note_provider'),
    /** 词源数据（AI 生成 JSON：词根、构词拓扑） */
    etymologyJson: text('etymology_json'),
    /** 学习状态：new / learning / review / mastered */
    status: text('status').notNull().default('new'),
    lastReviewedAt: integer('last_reviewed_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_words_book_lemma').on(t.wordBookId, t.lemma),
    index('idx_words_lemma').on(t.lemma),
  ]
);

/* ---------------------------------------------------------------------------
 * SRS 间隔重复 —— 需求 18：FSRS 调度（M4 实现，表结构先就位）
 * ------------------------------------------------------------------------- */
export const srsCards = sqliteTable(
  'srs_cards',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** 复习对象类型（当前仅 word，预留 phrase/cue） */
    itemType: text('item_type').notNull().default('word'),
    itemId: integer('item_id')
      .notNull()
      .references(() => words.id, { onDelete: 'cascade' }),
    /** FSRS 记忆稳定性（天） */
    stability: real('stability').notNull().default(0),
    /** FSRS 难度（0~10） */
    difficulty: real('difficulty').notNull().default(5),
    /** 下次到期时间 */
    dueMs: integer('due_ms', { mode: 'timestamp_ms' }).notNull(),
    lastReviewMs: integer('last_review_ms', { mode: 'timestamp_ms' }),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
  },
  (t) => [
    uniqueIndex('uq_srs_item').on(t.itemType, t.itemId),
    index('idx_srs_due').on(t.dueMs),
  ]
);

export const srsReviewLogs = sqliteTable(
  'srs_review_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: integer('card_id')
      .notNull()
      .references(() => srsCards.id, { onDelete: 'cascade' }),
    /** 评分：1 again / 2 hard / 3 good / 4 easy */
    rating: integer('rating').notNull(),
    /** 本次调度出的间隔（天） */
    scheduledDays: real('scheduled_days').notNull(),
    reviewedMs: integer('reviewed_ms', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('idx_srs_logs_card').on(t.cardId)]
);

/* ---------------------------------------------------------------------------
 * 句子收藏 —— 需求 13：自定义分类、AI 解析、重新生成
 * ------------------------------------------------------------------------- */
export const favoriteCategories = sqliteTable(
  'favorite_categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('uq_favcat_name').on(t.userId, t.name)]
);

export const favorites = sqliteTable(
  'favorites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    cueId: integer('cue_id')
      .notNull()
      .references(() => cues.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id').references(() => favoriteCategories.id, {
      onDelete: 'set null',
    }),
    /** AI 句子解析（Markdown）与状态/provider（支持重新生成） */
    aiAnalysisMd: text('ai_analysis_md'),
    aiAnalysisStatus: text('ai_analysis_status').notNull().default('none'),
    aiAnalysisProvider: text('ai_analysis_provider'),
    /** 用户笔记（Markdown） */
    noteMd: text('note_md'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_favorites_cue').on(t.userId, t.cueId),
    index('idx_favorites_category').on(t.categoryId),
  ]
);

/* ---------------------------------------------------------------------------
 * 学习进度 —— 需求 17：听过一遍解锁闯关
 * ------------------------------------------------------------------------- */
export const learningProgress = sqliteTable(
  'learning_progress',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id, { onDelete: 'cascade' }),
    /** 恢复播放点（需求 19 的「继续学习」） */
    lastPositionMs: integer('last_position_ms').notNull().default(0),
    /** 已听到的最大句序号 */
    maxCueIndex: integer('max_cue_index').notNull().default(0),
    /** 逐句听过位图（BLOB，bit i = 第 i 句听过） */
    listenedMask: blob('listened_mask'),
    /** 是否完整听过一遍（解锁闯关模式） */
    listenedThrough: integer('listened_through', { mode: 'boolean' }).notNull().default(false),
    firstListenCompletedAt: integer('first_listen_completed_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  // 唯一约束含 userId：与全库「预留 user_id 便于迁移多用户」约定一致（favorites 同款写法）
  (t) => [uniqueIndex('uq_progress_material').on(t.userId, t.materialId)]
);

/* ---------------------------------------------------------------------------
 * AI 服务配置档案 —— 五能力 × {本地引擎 | 云端 OpenAI 兼容端点}
 * ------------------------------------------------------------------------- */
export const providerProfiles = sqliteTable(
  'provider_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** 能力：stt / tts / align / translate / llm */
    capability: text('capability').notNull(),
    /** 档案显示名（「本地 faster-whisper」「GLM-4.7」） */
    name: text('name').notNull(),
    /** local 本地引擎 / cloud 云端端点 */
    kind: text('kind').notNull(),
    endpointUrl: text('endpoint_url'),
    /** API Key（仅服务端读取，接口永不回传） */
    apiKey: text('api_key'),
    /** 模型名 / 本地引擎规格（如 large-v3、en-GB-GeorgeNeural） */
    model: text('model'),
    /** 附加参数 JSON（音色、VAD 开关、温度等） */
    paramsJson: text('params_json'),
    /** 是否该能力当前默认（同一能力可多档案，用前下拉选择） */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index('idx_providers_capability').on(t.capability)]
);

/* ---------------------------------------------------------------------------
 * 应用偏好 —— 键值表（界面语言、字幕默认模式、播放默认倍速等）
 * ------------------------------------------------------------------------- */
export const settings = sqliteTable(
  'settings',
  {
    userId: integer('user_id').notNull().default(1),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  // 复合主键含 userId：遵守全库「所有表预留 user_id」约定，多用户迁移时免重建
  (t) => [primaryKey({ columns: [t.userId, t.key] })]
);

/* ---------------------------------------------------------------------------
 * 任务表 —— 导入/STT/翻译/AI 生成等长任务的持久化与崩溃恢复
 * ------------------------------------------------------------------------- */
export const jobs = sqliteTable(
  'jobs',
  {
    /** 任务 id（uuid 文本） */
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull().default(1),
    /** ai-engine 侧任务 id（若该步委托引擎） */
    engineJobId: text('engine_job_id'),
    type: text('type').notNull(),
    status: text('status').notNull().default('queued'),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'cascade' }),
    cueId: integer('cue_id').references(() => cues.id, { onDelete: 'cascade' }),
    payloadJson: text('payload_json'),
    resultJson: text('result_json'),
    /** 进度 0~1 */
    progress: real('progress').notNull().default(0),
    message: text('message'),
    providerProfile: text('provider_profile'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('idx_jobs_material').on(t.materialId),
    index('idx_jobs_status').on(t.status),
  ]
);

/* ---------------------------------------------------------------------------
 * 跟读录音（M2）与 AI 会话/产物（M3）
 * ------------------------------------------------------------------------- */
export const recordings = sqliteTable(
  'recordings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id, { onDelete: 'cascade' }),
    cueId: integer('cue_id')
      .notNull()
      .references(() => cues.id, { onDelete: 'cascade' }),
    /** 录音文件路径（相对 ~/.pinglc/media） */
    filePath: text('file_path').notNull(),
    durationMs: integer('duration_ms'),
    /** 跟读评分结果 JSON（M3：对齐对比） */
    scoreJson: text('score_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('idx_recordings_cue').on(t.cueId)]
);

export const aiThreads = sqliteTable('ai_threads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().default(1),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const aiMessages = sqliteTable(
  'ai_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: integer('thread_id')
      .notNull()
      .references(() => aiThreads.id, { onDelete: 'cascade' }),
    /** user / assistant */
    role: text('role').notNull(),
    contentMd: text('content_md').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('idx_ai_messages_thread').on(t.threadId)]
);

/** AI 产物通用缓存：句子解析 / 关卡页 HTML / 测验 / 词源 / 仿写构架 */
export const aiArtifacts = sqliteTable(
  'ai_artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    /** 产物类别：sentence_analysis / level_page / quiz / etymology / imitation */
    kind: text('kind').notNull(),
    /** 主体类型与 id（如 cue=42） */
    subjectType: text('subject_type').notNull(),
    subjectId: integer('subject_id').notNull(),
    provider: text('provider'),
    /** Markdown 内容（或关卡页 HTML 时存文件路径） */
    contentMd: text('content_md'),
    /** 产物文件路径（level_page 等大型 HTML） */
    artifactPath: text('artifact_path'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('idx_artifacts_subject').on(t.subjectType, t.subjectId)]
);

/* ---------------------------------------------------------------------------
 * 测验作答记录（M2）—— 错题回顾的数据源
 * ------------------------------------------------------------------------- */
export const quizAttempts = sqliteTable(
  'quiz_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id, { onDelete: 'cascade' }),
    /** 来源测验产物 id（ai_artifacts.quiz） */
    artifactId: integer('artifact_id'),
    /** 题型：choice / cloze / qa */
    questionType: text('question_type').notNull(),
    /** 题目快照 JSON（题干/选项/正确答案/解析；题目本体随测验删除仍可回顾） */
    questionJson: text('question_json').notNull(),
    /** 用户作答 */
    userAnswer: text('user_answer'),
    /** 判定（qa 题为用户自评） */
    isCorrect: integer('is_correct', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('idx_quiz_attempts_material').on(t.materialId),
    index('idx_quiz_attempts_wrong').on(t.isCorrect),
  ]
);
