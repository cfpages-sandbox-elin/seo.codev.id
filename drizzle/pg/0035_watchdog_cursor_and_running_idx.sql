CREATE TABLE IF NOT EXISTS "watchdog_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" text,
	"audit_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP
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
    WITH ranked AS (
      SELECT "id",
        "project_id",
        CASE
          WHEN "started_at" ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' THEN ("started_at" || '+00')::timestamptz
          WHEN pg_input_is_valid("started_at", 'timestamptz') THEN "started_at"::timestamptz
          ELSE NULL
        END AS valid_time,
        ROW_NUMBER() OVER (
          PARTITION BY "project_id"
          ORDER BY
            CASE
              WHEN "started_at" ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' THEN 1
              WHEN pg_input_is_valid("started_at", 'timestamptz') THEN 1
              ELSE 0
            END DESC,
            CASE
              WHEN "started_at" ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' THEN ("started_at" || '+00')::timestamptz
              WHEN pg_input_is_valid("started_at", 'timestamptz') THEN "started_at"::timestamptz
              ELSE NULL
            END DESC NULLS LAST,
            "id" DESC
        ) AS rn
      FROM "audits"
      WHERE "status" = 'running'
    )
    SELECT "id" FROM ranked WHERE rn > 1 OR valid_time IS NULL
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audits_project_running_idx" ON "audits" ("project_id") WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audits_running_keyset_idx" ON "audits" ("started_at", "id") WHERE status = 'running';
