PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`cue_id` integer,
	`material_id` integer,
	`text_en` text,
	`text_zh` text,
	`category_id` integer,
	`ai_analysis_md` text,
	`ai_analysis_status` text DEFAULT 'none' NOT NULL,
	`ai_analysis_provider` text,
	`note_md` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `favorite_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_favorites`("id", "user_id", "cue_id", "category_id", "ai_analysis_md", "ai_analysis_status", "ai_analysis_provider", "note_md", "created_at", "updated_at") SELECT "id", "user_id", "cue_id", "category_id", "ai_analysis_md", "ai_analysis_status", "ai_analysis_provider", "note_md", "created_at", "updated_at" FROM `favorites`;--> statement-breakpoint
DROP TABLE `favorites`;--> statement-breakpoint
ALTER TABLE `__new_favorites` RENAME TO `favorites`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_favorites_cue` ON `favorites` (`user_id`,`cue_id`);--> statement-breakpoint
CREATE INDEX `idx_favorites_category` ON `favorites` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_favorites_material` ON `favorites` (`material_id`);--> statement-breakpoint
CREATE TABLE `__new_recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`material_id` integer NOT NULL,
	`cue_id` integer,
	`file_path` text NOT NULL,
	`duration_ms` integer,
	`score_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_recordings`("id", "user_id", "material_id", "cue_id", "file_path", "duration_ms", "score_json", "created_at") SELECT "id", "user_id", "material_id", "cue_id", "file_path", "duration_ms", "score_json", "created_at" FROM `recordings`;--> statement-breakpoint
DROP TABLE `recordings`;--> statement-breakpoint
ALTER TABLE `__new_recordings` RENAME TO `recordings`;--> statement-breakpoint
CREATE INDEX `idx_recordings_cue` ON `recordings` (`cue_id`);--> statement-breakpoint
--> ---- 存量回填：收藏快照（cue_id 此刻全部有效，从 cues 取原文/译文/出处）----
UPDATE `favorites` SET `material_id` = (SELECT `material_id` FROM `cues` WHERE `cues`.`id` = `favorites`.`cue_id`) WHERE `material_id` IS NULL AND `cue_id` IS NOT NULL;--> statement-breakpoint
UPDATE `favorites` SET `text_en` = (SELECT `text_en` FROM `cues` WHERE `cues`.`id` = `favorites`.`cue_id`) WHERE `text_en` IS NULL AND `cue_id` IS NOT NULL;--> statement-breakpoint
UPDATE `favorites` SET `text_zh` = (SELECT `text_zh` FROM `cues` WHERE `cues`.`id` = `favorites`.`cue_id`) WHERE `text_zh` IS NULL AND `cue_id` IS NOT NULL;