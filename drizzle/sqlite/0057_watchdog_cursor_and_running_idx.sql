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
    `current_phase` = 'failed',
    `failed_phase` = COALESCE(`current_phase`, 'running'),
    `error_code` = 'MIGRATION_CONCURRENCY_RECONCILED',
    `completed_at` = COALESCE(`completed_at`, CURRENT_TIMESTAMP)
WHERE `status` = 'running'
  AND `id` IN (
    WITH ranked AS (
      SELECT `id`,
        `project_id`,
        CASE WHEN julianday(`started_at`) IS NOT NULL THEN julianday(`started_at`) ELSE NULL END AS valid_time,
        ROW_NUMBER() OVER (
          PARTITION BY `project_id`
          ORDER BY
            CASE WHEN julianday(`started_at`) IS NOT NULL THEN 1 ELSE 0 END DESC,
            julianday(`started_at`) DESC,
            `id` DESC
        ) AS rn
      FROM `audits`
      WHERE `status` = 'running'
    )
    SELECT `id` FROM ranked WHERE rn > 1 OR valid_time IS NULL
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audits_project_running_idx` ON `audits` (`project_id`) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audits_running_keyset_idx` ON `audits` (`started_at`, `id`) WHERE status = 'running';
