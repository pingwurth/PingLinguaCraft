PRAGMA foreign_keys=OFF;--> statement-breakpoint
--> ---- 复习日志撤离：DROP srs_cards 的隐式 DELETE 会按 card_id CASCADE 清空
--> ---- srs_review_logs（实测复现），先备份清空、rebuild 后回填（索引在原表上无损）----
CREATE TABLE `__srs_logs_keep` AS SELECT * FROM `srs_review_logs`;--> statement-breakpoint
DELETE FROM `srs_review_logs`;--> statement-breakpoint
CREATE TABLE `__new_srs_cards` (
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
	FOREIGN KEY (`item_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_srs_item_word" CHECK("__new_srs_cards"."item_type" = 'word')
);
--> statement-breakpoint
INSERT INTO `__new_srs_cards`("id", "user_id", "item_type", "item_id", "stability", "difficulty", "due_ms", "last_review_ms", "reps", "lapses") SELECT "id", "user_id", "item_type", "item_id", "stability", "difficulty", "due_ms", "last_review_ms", "reps", "lapses" FROM `srs_cards`;--> statement-breakpoint
DROP TABLE `srs_cards`;--> statement-breakpoint
ALTER TABLE `__new_srs_cards` RENAME TO `srs_cards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_srs_item` ON `srs_cards` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_srs_due` ON `srs_cards` (`due_ms`);--> statement-breakpoint
--> ---- 复习日志回填（card id 全量保序，FK 校验可通过）后清理备份 ----
INSERT INTO `srs_review_logs`("id", "card_id", "rating", "scheduled_days", "reviewed_ms") SELECT "id", "card_id", "rating", "scheduled_days", "reviewed_ms" FROM `__srs_logs_keep`;--> statement-breakpoint
DROP TABLE `__srs_logs_keep`;