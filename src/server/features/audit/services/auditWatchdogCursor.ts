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
    WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?$'
     AND pg_input_is_valid(${expr} || '+00', 'timestamptz')
    THEN (${expr} || '+00')::timestamptz
    WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     AND pg_input_is_valid(${expr}, 'timestamptz')
    THEN (${expr})::timestamptz
    ELSE NULL
  END
)`;

export const sqliteTimeExpr = (
  expr: SQL | Column | string | null | undefined,
) => sql`(
  CASE
    WHEN ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
     AND ${expr} = strftime('%Y-%m-%d %H:%M:%S', ${expr})
    THEN julianday(${expr})
    WHEN ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
     AND substr(${expr}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${expr}, 1, 19))
     AND (length(${expr}) = 20 OR substr(${expr}, 20) GLOB '.[0-9]*Z')
     AND julianday(${expr}) IS NOT NULL
    THEN julianday(${expr})
    WHEN ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*[+-][0-9][0-9]:[0-9][0-9]'
     AND substr(${expr}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${expr}, 1, 19))
     AND julianday(${expr}) IS NOT NULL
    THEN julianday(${expr})
    ELSE NULL
  END
)`;

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
): Promise<{
  result: CursorSaveResult;
  revision?: number;
  cursor?: WatchdogCursor;
}> {
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
        ? { result: "applied", revision: res[0].revision, cursor }
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
          updatedAt: isPg ? nowIso : undefined,
        })
        .onConflictDoNothing()
        .returning({ revision: watchdogCursor.revision });

      return res.length > 0
        ? { result: "applied", revision: res[0].revision, cursor }
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
        ? { result: "applied", revision: res[0].revision, cursor }
        : { result: "conflict" };
    }

    const res = await db
      .insert(watchdogCursor)
      .values({
        id: "singleton",
        startedAt: cursor ? cursor.startedAt : null,
        auditId: cursor ? cursor.id : null,
        revision: 1,
        updatedAt: isPg ? nowIso : undefined,
      })
      .onConflictDoNothing()
      .returning({ revision: watchdogCursor.revision });

    return res.length > 0
      ? { result: "applied", revision: res[0].revision, cursor }
      : { result: "conflict" };
  } catch (error) {
    console.error("Audit watchdog: database error saving cursor:", error);
    return { result: "error" };
  }
}
