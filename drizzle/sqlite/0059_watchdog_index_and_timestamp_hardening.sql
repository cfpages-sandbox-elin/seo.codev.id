UPDATE `audits`
SET `status` = 'failed',
    `current_phase` = 'failed',
    `failed_phase` = COALESCE(`current_phase`, 'running'),
    `error_code` = 'invalid_started_at',
    `completed_at` = COALESCE(`completed_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE `status` = 'running'
  AND (
    `started_at` IS NULL
    OR (
      CASE
        WHEN substr(`started_at`, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
         AND substr(`started_at`, 12, 2) < '24'
         AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%d %H:%M:%S', substr(`started_at`, 1, 19))
         AND (length(`started_at`) = 19 OR (length(`started_at`) BETWEEN 21 AND 23 AND substr(`started_at`, 20) GLOB '.[0-9]*' AND substr(`started_at`, 21) NOT GLOB '*[^0-9]*'))
         AND julianday(`started_at`) IS NOT NULL
        THEN julianday(`started_at`)
        WHEN `started_at` LIKE '%Z'
         AND substr(`started_at`, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
         AND substr(`started_at`, 12, 2) < '24'
         AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(`started_at`, 1, 19))
         AND (length(`started_at`) = 20 OR (length(`started_at`) BETWEEN 22 AND 24 AND substr(`started_at`, 20, length(`started_at`) - 20) GLOB '.[0-9]*' AND substr(`started_at`, 21, length(`started_at`) - 21) NOT GLOB '*[^0-9]*'))
         AND julianday(`started_at`) IS NOT NULL
        THEN julianday(`started_at`)
        ELSE NULL
      END
    ) IS NULL
  );
--> statement-breakpoint
UPDATE `audits`
SET `started_at` = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(`started_at`))
WHERE `status` = 'running'
  AND NOT (`started_at` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND substr(`started_at`, 12, 2) < '24');
