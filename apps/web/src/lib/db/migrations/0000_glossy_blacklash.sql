CREATE TABLE `ai_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`provider` text,
	`content_md` text,
	`artifact_path` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_subject` ON `ai_artifacts` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`role` text NOT NULL,
	`content_md` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `ai_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_messages_thread` ON `ai_messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `ai_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cover` text,
	`cefr_level` text,
	`ai_depth_preset` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_collections_user` ON `collections` (`user_id`);--> statement-breakpoint
CREATE TABLE `cues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`material_id` integer NOT NULL,
	`index` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`text_en` text NOT NULL,
	`text_zh` text,
	`translation_provider` text,
	`stt_confidence` real,
	`words_json` text,
	`is_edited` integer DEFAULT false NOT NULL,
	`note_md` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cues_material_index` ON `cues` (`material_id`,`index`);--> statement-breakpoint
CREATE INDEX `idx_cues_material` ON `cues` (`material_id`);--> statement-breakpoint
CREATE TABLE `favorite_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_favcat_name` ON `favorite_categories` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`cue_id` integer NOT NULL,
	`category_id` integer,
	`ai_analysis_md` text,
	`ai_analysis_status` text DEFAULT 'none' NOT NULL,
	`ai_analysis_provider` text,
	`note_md` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `favorite_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_favorites_cue` ON `favorites` (`user_id`,`cue_id`);--> statement-breakpoint
CREATE INDEX `idx_favorites_category` ON `favorites` (`category_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`engine_job_id` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`material_id` integer,
	`cue_id` integer,
	`payload_json` text,
	`result_json` text,
	`progress` real DEFAULT 0 NOT NULL,
	`message` text,
	`provider_profile` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_material` ON `jobs` (`material_id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `learning_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`material_id` integer NOT NULL,
	`last_position_ms` integer DEFAULT 0 NOT NULL,
	`max_cue_index` integer DEFAULT 0 NOT NULL,
	`listened_mask` blob,
	`listened_through` integer DEFAULT false NOT NULL,
	`first_listen_completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_progress_material` ON `learning_progress` (`material_id`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`collection_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`source_type` text NOT NULL,
	`source_url` text,
	`media_path` text,
	`media_mime` text,
	`media_duration_ms` integer,
	`media_size_bytes` integer,
	`peaks_path` text,
	`subtitle_status` text DEFAULT 'none' NOT NULL,
	`sentence_count` integer,
	`unique_word_count` integer,
	`metadata_json` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_materials_collection` ON `materials` (`collection_id`);--> statement-breakpoint
CREATE INDEX `idx_materials_status` ON `materials` (`subtitle_status`);--> statement-breakpoint
CREATE TABLE `provider_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`capability` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint_url` text,
	`api_key` text,
	`model` text,
	`params_json` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_providers_capability` ON `provider_profiles` (`capability`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`material_id` integer NOT NULL,
	`cue_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`duration_ms` integer,
	`score_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_recordings_cue` ON `recordings` (`cue_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `srs_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`item_type` text DEFAULT 'word' NOT NULL,
	`item_id` integer NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 5 NOT NULL,
	`due_ms` integer NOT NULL,
	`last_review_ms` integer,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_srs_item` ON `srs_cards` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_srs_due` ON `srs_cards` (`due_ms`);--> statement-breakpoint
CREATE TABLE `srs_review_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`rating` integer NOT NULL,
	`scheduled_days` real NOT NULL,
	`reviewed_ms` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `srs_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_srs_logs_card` ON `srs_review_logs` (`card_id`);--> statement-breakpoint
CREATE TABLE `word_books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_word_books_name` ON `word_books` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `words` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`word_book_id` integer NOT NULL,
	`lemma` text NOT NULL,
	`display_form` text NOT NULL,
	`phonetic_uk` text,
	`phonetic_us` text,
	`origin_cue_id` integer,
	`origin_material_id` integer,
	`note_md` text,
	`ai_note_md` text,
	`ai_note_status` text DEFAULT 'none' NOT NULL,
	`ai_note_provider` text,
	`etymology_json` text,
	`status` text DEFAULT 'new' NOT NULL,
	`last_reviewed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`word_book_id`) REFERENCES `word_books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`origin_material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_words_book_lemma` ON `words` (`word_book_id`,`lemma`);--> statement-breakpoint
CREATE INDEX `idx_words_lemma` ON `words` (`lemma`);