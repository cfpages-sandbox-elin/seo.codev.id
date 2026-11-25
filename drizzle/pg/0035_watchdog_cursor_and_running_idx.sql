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
    "error_code" = 'MIGRATION_CONCURRENCY_RECONCILED',
    "completed_at" = COALESCE(
      "completed_at",
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
WHERE "status" = 'running'
  AND "id" NOT IN (
    SELECT a1."id"
    FROM "audits" a1
    WHERE a1."status" = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM "audits" a2
        WHERE a2."project_id" = a1."project_id"
          AND a2."status" = 'running'
          AND (
            (CASE WHEN pg_input_is_valid(a2."started_at", 'timestamptz') THEN a2."started_at"::timestamptz END >
             CASE WHEN pg_input_is_valid(a1."started_at", 'timestamptz') THEN a1."started_at"::timestamptz END)
            OR (
              (CASE WHEN pg_input_is_valid(a2."started_at", 'timestamptz') THEN a2."started_at"::timestamptz END =
               CASE WHEN pg_input_is_valid(a1."started_at", 'timestamptz') THEN a1."started_at"::timestamptz END)
              AND a2."id" > a1."id"
            )
          )
      )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audits_project_running_idx" ON "audits" ("project_id") WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audits_running_keyset_idx" ON "audits" ("started_at", "id") WHERE status = 'running';
