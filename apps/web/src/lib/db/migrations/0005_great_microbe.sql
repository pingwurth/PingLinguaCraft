PRAGMA foreign_keys=OFF;--> statement-breakpoint
--> ---- 存量悬空引用清理（FK 长期关闭年代的残留；运行时连接将开启 FK，悬空行须在 rebuild 前清干净）----
UPDATE `favorites` SET `cue_id` = NULL WHERE `cue_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `cues` WHERE `cues`.`id` = `favorites`.`cue_id`);--> statement-breakpoint
UPDATE `favorites` SET `material_id` = NULL WHERE `material_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `materials` WHERE `materials`.`id` = `favorites`.`material_id`);--> statement-breakpoint
UPDATE `recordings` SET `cue_id` = NULL WHERE `cue_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `cues` WHERE `cues`.`id` = `recordings`.`cue_id`);--> statement-breakpoint
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
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `favorite_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_favorites`("id", "user_id", "cue_id", "material_id", "text_en", "text_zh", "category_id", "ai_analysis_md", "ai_analysis_status", "ai_analysis_provider", "note_md", "created_at", "updated_at") SELECT "id", "user_id", "cue_id", "material_id", "text_en", "text_zh", "category_id", "ai_analysis_md", "ai_analysis_status", "ai_analysis_provider", "note_md", "created_at", "updated_at" FROM `favorites`;--> statement-breakpoint
DROP TABLE `favorites`;--> statement-breakpoint
ALTER TABLE `__new_favorites` RENAME TO `favorites`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_favorites_cue` ON `favorites` (`user_id`,`cue_id`);--> statement-breakpoint
CREATE INDEX `idx_favorites_category` ON `favorites` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_favorites_material` ON `favorites` (`material_id`);