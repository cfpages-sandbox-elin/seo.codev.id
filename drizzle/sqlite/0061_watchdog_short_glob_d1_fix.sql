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
        WHEN instr(`started_at`, char(0)) = 0
         AND substr(`started_at`, 1, 4) > '0000'
         AND substr(`started_at`, 5, 1) = '-' AND substr(`started_at`, 8, 1) = '-' AND substr(`started_at`, 11, 1) = ' '
         AND substr(`started_at`, 14, 1) = ':' AND substr(`started_at`, 17, 1) = ':'
         AND (substr(`started_at`, 1, 4) || substr(`started_at`, 6, 2) || substr(`started_at`, 9, 2) || substr(`started_at`, 12, 2) || substr(`started_at`, 15, 2) || substr(`started_at`, 18, 2)) NOT GLOB '*[^0-9]*'
         AND substr(`started_at`, 12, 2) < '24'
         AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%d %H:%M:%S', substr(`started_at`, 1, 19))
         AND (length(`started_at`) = 19 OR (length(`started_at`) BETWEEN 21 AND 23 AND substr(`started_at`, 20, 1) = '.' AND substr(`started_at`, 21) NOT GLOB '*[^0-9]*'))
         AND julianday(`started_at`) IS NOT NULL
        THEN julianday(`started_at`)
        WHEN instr(`started_at`, char(0)) = 0
         AND substr(`started_at`, 1, 4) > '0000'
         AND length(`started_at`) >= 20
         AND unicode(substr(`started_at`, length(`started_at`), 1)) = 90
         AND substr(`started_at`, 5, 1) = '-' AND substr(`started_at`, 8, 1) = '-' AND unicode(substr(`started_at`, 11, 1)) = 84
         AND substr(`started_at`, 14, 1) = ':' AND substr(`started_at`, 17, 1) = ':'
         AND (substr(`started_at`, 1, 4) || substr(`started_at`, 6, 2) || substr(`started_at`, 9, 2) || substr(`started_at`, 12, 2) || substr(`started_at`, 15, 2) || substr(`started_at`, 18, 2)) NOT GLOB '*[^0-9]*'
         AND substr(`started_at`, 12, 2) < '24'
         AND substr(`started_at`, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(`started_at`, 1, 19))
         AND (length(`started_at`) = 20 OR (length(`started_at`) BETWEEN 22 AND 24 AND substr(`started_at`, 20, 1) = '.' AND substr(`started_at`, 21, length(`started_at`) - 21) NOT GLOB '*[^0-9]*'))
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
  AND NOT (
    instr(`started_at`, char(0)) = 0
    AND length(`started_at`) = 24
    AND substr(`started_at`, 1, 4) > '0000'
    AND unicode(substr(`started_at`, 11, 1)) = 84
    AND unicode(substr(`started_at`, 24, 1)) = 90
    AND substr(`started_at`, 5, 1) = '-' AND substr(`started_at`, 8, 1) = '-'
    AND substr(`started_at`, 14, 1) = ':' AND substr(`started_at`, 17, 1) = ':' AND substr(`started_at`, 20, 1) = '.'
    AND (substr(`started_at`, 1, 4) || substr(`started_at`, 6, 2) || substr(`started_at`, 9, 2) || substr(`started_at`, 12, 2) || substr(`started_at`, 15, 2) || substr(`started_at`, 18, 2) || substr(`started_at`, 21, 3)) NOT GLOB '*[^0-9]*'
    AND substr(`started_at`, 12, 2) < '24'
  );
