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
    `completed_at` = COALESCE(`completed_at`, strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now'))
WHERE `status` = 'running'
  AND `id` IN (
    WITH parsed AS (
      SELECT `id`,
        `project_id`,
        CASE
          WHEN instr(`started_at`, char(0)) = 0
           AND substr(`started_at`, 1, 4) > '0000'
           AND substr(`started_at`, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
           AND substr(`started_at`, 12, 2) < '24'
           AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%d %H:%M:%S', substr(`started_at`, 1, 19))
           AND (length(`started_at`) = 19 OR (length(`started_at`) BETWEEN 21 AND 23 AND substr(`started_at`, 20) GLOB '.[0-9]*' AND substr(`started_at`, 21) NOT GLOB '*[^0-9]*'))
           AND julianday(`started_at`) IS NOT NULL
          THEN julianday(`started_at`)
          WHEN instr(`started_at`, char(0)) = 0
           AND substr(`started_at`, 1, 4) > '0000'
           AND `started_at` GLOB '*Z'
           AND substr(`started_at`, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
           AND substr(`started_at`, 12, 2) < '24'
           AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(`started_at`, 1, 19))
           AND (length(`started_at`) = 20 OR (length(`started_at`) BETWEEN 22 AND 24 AND substr(`started_at`, 20, length(`started_at`) - 20) GLOB '.[0-9]*' AND substr(`started_at`, 21, length(`started_at`) - 21) NOT GLOB '*[^0-9]*'))
           AND julianday(`started_at`) IS NOT NULL
          THEN julianday(`started_at`)
          WHEN instr(`started_at`, char(0)) = 0
           AND substr(`started_at`, 1, 4) > '0000'
           AND `started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*[+-][0-9][0-9]:[0-9][0-9]'
           AND substr(`started_at`, 12, 2) < '24'
           AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(`started_at`, 1, 19))
           AND julianday(`started_at`) IS NOT NULL
          THEN julianday(`started_at`)
          ELSE NULL
        END AS valid_time
      FROM `audits`
      WHERE `status` = 'running'
    ),
    ranked AS (
      SELECT `id`,
        `project_id`,
        valid_time,
        ROW_NUMBER() OVER (
          PARTITION BY `project_id`
          ORDER BY
            CASE WHEN valid_time IS NOT NULL THEN 1 ELSE 0 END DESC,
            valid_time DESC,
            `id` COLLATE BINARY DESC
        ) AS rn
      FROM parsed
    )
    SELECT `id` FROM ranked WHERE rn > 1 OR valid_time IS NULL
  );
--> statement-breakpoint
UPDATE `audits`
SET `started_at` = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(`started_at`))
WHERE `status` = 'running'
  AND NOT (`started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audits_project_running_idx` ON `audits` (`project_id`) WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audits_running_keyset_idx` ON `audits` (`started_at`, `id`) WHERE status = 'running';
