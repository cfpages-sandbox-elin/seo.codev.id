CREATE TABLE IF NOT EXISTS `watchdog_cursor` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text,
	`audit_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT (current_timestamp)
);
--> statement-breakpoint
UPDATE `audits`
SET `status` = 'failed',
    `error_code` = 'MIGRATION_CONCURRENCY_RECONCILED',
    `completed_at` = COALESCE(`completed_at`, CURRENT_TIMESTAMP)
WHERE `status` = 'running'
  AND `id` NOT IN (
    SELECT a1.`id`
    FROM `audits` a1
    WHERE a1.`status` = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM `audits` a2
        WHERE a2.`project_id` = a1.`project_id`
          AND a2.`status` = 'running'
          AND (a2.`started_at` > a1.`started_at` OR (a2.`started_at` = a1.`started_at` AND a2.`id` > a1.`id`))
      )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audits_project_running_idx` ON `audits` (`project_id`) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audits_running_keyset_idx` ON `audits` (`started_at`, `id`) WHERE status = 'running';
