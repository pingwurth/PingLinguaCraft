CREATE TABLE `quiz_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`material_id` integer NOT NULL,
	`artifact_id` integer,
	`question_type` text NOT NULL,
	`question_json` text NOT NULL,
	`user_answer` text,
	`is_correct` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_quiz_attempts_material` ON `quiz_attempts` (`material_id`);--> statement-breakpoint
CREATE INDEX `idx_quiz_attempts_wrong` ON `quiz_attempts` (`is_correct`);