CREATE TABLE IF NOT EXISTS `watchdog_cursor` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text,
	`audit_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT (current_timestamp)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audits_project_running_idx` ON `audits` (`project_id`) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audits_running_keyset_idx` ON `audits` (`started_at`, `id`) WHERE status = 'running';
