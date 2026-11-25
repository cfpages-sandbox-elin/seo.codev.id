CREATE TABLE IF NOT EXISTS "watchdog_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" text,
	"audit_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
--> statement-breakpoint
UPDATE "audits"
SET "status" = 'failed',
    "current_phase" = 'failed',
    "failed_phase" = COALESCE("current_phase", 'running'),
    "error_code" = 'MIGRATION_CONCURRENCY_RECONCILED',
    "completed_at" = COALESCE(
      "completed_at",
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
WHERE "status" = 'running'
  AND "id" IN (
    WITH parsed AS (
      SELECT "id",
        "project_id",
        CASE
          WHEN "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?$'
           AND pg_input_is_valid("started_at" || '+00', 'timestamptz') THEN ("started_at" || '+00')::timestamptz
          WHEN "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
           AND pg_input_is_valid("started_at", 'timestamptz') THEN "started_at"::timestamptz
          ELSE NULL
        END AS valid_time
      FROM "audits"
      WHERE "status" = 'running'
    ),
    ranked AS (
      SELECT "id",
        "project_id",
        valid_time,
        ROW_NUMBER() OVER (
          PARTITION BY "project_id"
          ORDER BY
            CASE WHEN valid_time IS NOT NULL THEN 1 ELSE 0 END DESC,
            valid_time DESC NULLS LAST,
            "id" COLLATE "C" DESC
        ) AS rn
      FROM parsed
    )
    SELECT "id" FROM ranked WHERE rn > 1 OR valid_time IS NULL
  );
--> statement-breakpoint
UPDATE "audits"
SET "started_at" = to_char(
  (
    CASE
      WHEN "started_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?$'
       THEN ("started_at" || '+00')::timestamptz
      ELSE "started_at"::timestamptz
    END
  ) AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
)
WHERE "status" = 'running'
  AND "started_at" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audits_project_running_idx" ON "audits" ("project_id") WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audits_running_keyset_idx" ON "audits" ("started_at", "id") WHERE status = 'running';
