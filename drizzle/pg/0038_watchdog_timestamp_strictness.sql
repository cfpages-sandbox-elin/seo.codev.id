UPDATE "audits"
SET "status" = 'failed',
    "current_phase" = 'failed',
    "failed_phase" = COALESCE("current_phase", 'running'),
    "error_code" = 'invalid_started_at',
    "completed_at" = COALESCE(
      "completed_at",
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
WHERE "status" = 'running'
  AND (
    "started_at" IS NULL
    OR (
      CASE
        WHEN substr("started_at", 1, 4) > '0000'
         AND "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?$'
         AND pg_input_is_valid("started_at" || '+00', 'timestamptz') THEN ("started_at" || '+00')::timestamptz
        WHEN substr("started_at", 1, 4) > '0000'
         AND "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?Z$'
         AND pg_input_is_valid("started_at", 'timestamptz') THEN "started_at"::timestamptz
        ELSE NULL
      END
    ) IS NULL
  );
--> statement-breakpoint
UPDATE "audits"
SET "started_at" = to_char(
  (
    CASE
      WHEN "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?$'
       THEN ("started_at" || '+00')::timestamptz
      ELSE "started_at"::timestamptz
    END
  ) AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
)
WHERE "status" = 'running'
  AND NOT (
    substr("started_at", 1, 4) > '0000'
    AND "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
  );
