CREATE TABLE `challenge_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`material_id` integer NOT NULL,
	`mode` text NOT NULL,
	`score` real NOT NULL,
	`detail_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_challenge_mode` ON `challenge_records` (`material_id`,`mode`);--> statement-breakpoint
CREATE INDEX `idx_challenge_material` ON `challenge_records` (`material_id`);