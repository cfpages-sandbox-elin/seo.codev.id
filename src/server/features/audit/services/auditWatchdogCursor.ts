import { and, eq, sql, type Column, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { watchdogCursor } from "@/db/schema";

export type WatchdogCursor = {
  startedAt: string;
  id: string;
} | null;

export type LoadedCursorState =
  | { kind: "persisted"; cursor: WatchdogCursor; revision: number }
  | { kind: "absent"; cursor: null; revision: null }
  | { kind: "read_error"; cursor: null; revision: null };

type CursorSaveResult = "applied" | "conflict" | "error";

export const pgTimeExpr = (
  expr: SQL | Column | string | null | undefined,
) => sql`(
  CASE
    WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?$'
     AND pg_input_is_valid(${expr} || '+00', 'timestamptz')
    THEN (${expr} || '+00')::timestamptz
    WHEN pg_input_is_valid(${expr}, 'timestamptz')
    THEN (${expr})::timestamptz
    ELSE NULL
  END
)`;

export const pgBucketExpr = (expr: SQL | Column | string | null | undefined) =>
  sql`(CASE WHEN ${pgTimeExpr(expr)} IS NULL THEN 0 ELSE 1 END)`;

export const pgNormalizedTimeExpr = (
  expr: SQL | Column | string | null | undefined,
) => sql`COALESCE(${pgTimeExpr(expr)}, '1970-01-01 00:00:00+00'::timestamptz)`;

export const sqliteBucketExpr = (
  expr: SQL | Column | string | null | undefined,
) => sql`(CASE WHEN julianday(${expr}) IS NULL THEN 0 ELSE 1 END)`;

export const sqliteNormalizedTimeExpr = (
  expr: SQL | Column | string | null | undefined,
) => sql`COALESCE(julianday(${expr}), 0.0)`;

export async function loadPersistedCursor(): Promise<LoadedCursorState> {
  try {
    const row = await db.query.watchdogCursor.findFirst({
      where: eq(watchdogCursor.id, "singleton"),
    });
    if (row) {
      if (row.startedAt && row.auditId) {
        return {
          kind: "persisted",
          cursor: { startedAt: row.startedAt, id: row.auditId },
          revision: row.revision,
        };
      }
      return { kind: "persisted", cursor: null, revision: row.revision };
    }
    return { kind: "absent", cursor: null, revision: null };
  } catch {
    return { kind: "read_error", cursor: null, revision: null };
  }
}

export async function savePersistedCursor(
  cursor: WatchdogCursor,
  expectedRevision?: number | null,
): Promise<{ result: CursorSaveResult; cursor?: WatchdogCursor }> {
  try {
    const isPg = getDatabaseProvider() === "postgres";
    const nowIso = new Date().toISOString();

    if (expectedRevision !== undefined && expectedRevision !== null) {
      const res = await db
        .update(watchdogCursor)
        .set({
          startedAt: cursor ? cursor.startedAt : null,
          auditId: cursor ? cursor.id : null,
          revision: expectedRevision + 1,
          updatedAt: isPg ? nowIso : sql`(current_timestamp)`,
        })
        .where(
          and(
            eq(watchdogCursor.id, "singleton"),
            eq(watchdogCursor.revision, expectedRevision),
          ),
        )
        .returning({ revision: watchdogCursor.revision });

      return res.length > 0
        ? { result: "applied", cursor }
        : { result: "conflict" };
    }

    if (expectedRevision === null) {
      const res = await db
        .insert(watchdogCursor)
        .values({
          id: "singleton",
          startedAt: cursor ? cursor.startedAt : null,
          auditId: cursor ? cursor.id : null,
          revision: 1,
        })
        .onConflictDoNothing()
        .returning({ revision: watchdogCursor.revision });

      return res.length > 0
        ? { result: "applied", cursor }
        : { result: "conflict" };
    }

    const existing = await db.query.watchdogCursor.findFirst({
      where: eq(watchdogCursor.id, "singleton"),
    });

    if (existing) {
      const res = await db
        .update(watchdogCursor)
        .set({
          startedAt: cursor ? cursor.startedAt : null,
          auditId: cursor ? cursor.id : null,
          revision: existing.revision + 1,
          updatedAt: isPg ? nowIso : sql`(current_timestamp)`,
        })
        .where(
          and(
            eq(watchdogCursor.id, "singleton"),
            eq(watchdogCursor.revision, existing.revision),
          ),
        )
        .returning({ revision: watchdogCursor.revision });

      return res.length > 0
        ? { result: "applied", cursor }
        : { result: "conflict" };
    }

    const res = await db
      .insert(watchdogCursor)
      .values({
        id: "singleton",
        startedAt: cursor ? cursor.startedAt : null,
        auditId: cursor ? cursor.id : null,
        revision: 1,
      })
      .onConflictDoNothing()
      .returning({ revision: watchdogCursor.revision });

    return res.length > 0
      ? { result: "applied", cursor }
      : { result: "conflict" };
  } catch (error) {
    console.error("Audit watchdog: database error saving cursor:", error);
    return { result: "error" };
  }
}
