import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  not,
  sql,
  type Column,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { audits, watchdogCursor } from "@/db/schema";

export type WatchdogCursor = {
  startedAt: string;
  id: string;
} | null;

export type LoadedCursorState =
  | { kind: "persisted"; cursor: WatchdogCursor; revision: number }
  | { kind: "absent"; cursor: null; revision: null }
  | { kind: "read_error"; cursor: null; revision: null };

type CursorSaveResult = "applied" | "conflict" | "error";

const pgTimeExpr = (expr: SQL | Column | string | null | undefined) => sql`(
  CASE
    WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?$'
     AND pg_input_is_valid(${expr} || '+00', 'timestamptz')
    THEN (${expr} || '+00')::timestamptz
    WHEN ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?Z$'
     AND pg_input_is_valid(${expr}, 'timestamptz')
    THEN (${expr})::timestamptz
    ELSE NULL
  END
)`;

const sqliteTimeExpr = (expr: SQL | Column | string | null | undefined) => sql`(
  CASE
    WHEN substr(${expr}, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
     AND substr(${expr}, 12, 2) < '24'
     AND substr(${expr}, 1, 19) = strftime('%Y-%m-%d %H:%M:%S', substr(${expr}, 1, 19))
     AND (length(${expr}) = 19 OR (length(${expr}) BETWEEN 21 AND 23 AND substr(${expr}, 20) GLOB '.[0-9]*' AND substr(${expr}, 21) NOT GLOB '*[^0-9]*'))
     AND julianday(${expr}) IS NOT NULL
    THEN julianday(${expr})
    WHEN ${expr} LIKE '%Z'
     AND substr(${expr}, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
     AND substr(${expr}, 12, 2) < '24'
     AND substr(${expr}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${expr}, 1, 19))
     AND (length(${expr}) = 20 OR (length(${expr}) BETWEEN 22 AND 24 AND substr(${expr}, 20, length(${expr}) - 20) GLOB '.[0-9]*' AND substr(${expr}, 21, length(${expr}) - 21) NOT GLOB '*[^0-9]*'))
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

/** Query running audits with null workflow instance ID or non-canonical/invalid started_at timestamps (Sol R5). */
export async function findIrregularRunningAudits(
  limit: number,
  cursorId: string | null,
) {
  const isPg = getDatabaseProvider() === "postgres";
  const isNullOrInvalid = isPg
    ? sql`(${audits.workflowInstanceId} IS NULL OR ${pgTimeExpr(audits.startedAt)} IS NULL OR ${audits.startedAt} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$')`
    : sql`(${audits.workflowInstanceId} IS NULL OR ${sqliteTimeExpr(audits.startedAt)} IS NULL OR NOT (${audits.startedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND substr(${audits.startedAt}, 12, 2) < '24'))`;

  const cursorFilter = cursorId
    ? isPg
      ? sql`${audits.id} COLLATE "C" > ${cursorId}`
      : sql`${audits.id} COLLATE BINARY > ${cursorId}`
    : undefined;

  return db.query.audits.findMany({
    where: and(eq(audits.status, "running"), isNullOrInvalid, cursorFilter),
    orderBy: isPg
      ? [sql`${audits.id} COLLATE "C" ASC`]
      : [sql`${audits.id} COLLATE BINARY ASC`],
    limit,
    columns: {
      id: true,
      workflowInstanceId: true,
      startedAt: true,
      currentPhase: true,
    },
  });
}

/** Query canonical ISO-Z stale running audits ordered by (started_at, id) keyset index (Sol R5). */
export async function getStaleRunningAudits(
  cutoff: Date,
  limit: number,
  cursor: WatchdogCursor,
) {
  const isPg = getDatabaseProvider() === "postgres";
  const edgeCutoffIso = cutoff.toISOString();
  const repoCutoffIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const canonicalFormat = isPg
    ? sql`${audits.startedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$' AND ${pgTimeExpr(audits.startedAt)} IS NOT NULL`
    : sql`${audits.startedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND substr(${audits.startedAt}, 12, 2) < '24' AND ${sqliteTimeExpr(audits.startedAt)} IS NOT NULL`;

  const stalenessPredicate = isPg
    ? sql`${audits.startedAt} COLLATE "C" < ${edgeCutoffIso} COLLATE "C" AND (${audits.workflowInstanceId} NOT LIKE 'github-audit-%' OR ${audits.startedAt} COLLATE "C" < ${repoCutoffIso} COLLATE "C")`
    : sql`${audits.startedAt} < ${edgeCutoffIso} AND (${audits.workflowInstanceId} NOT LIKE 'github-audit-%' OR ${audits.startedAt} < ${repoCutoffIso})`;

  const cursorPredicate = cursor
    ? isPg
      ? sql`(${audits.startedAt} COLLATE "C", ${audits.id} COLLATE "C") > (${cursor.startedAt} COLLATE "C", ${cursor.id} COLLATE "C")`
      : sql`(${audits.startedAt}, ${audits.id}) > (${cursor.startedAt}, ${cursor.id})`
    : undefined;

  return db.query.audits.findMany({
    where: and(
      eq(audits.status, "running"),
      isNotNull(audits.workflowInstanceId),
      not(isNull(audits.startedAt)),
      canonicalFormat,
      stalenessPredicate,
      cursorPredicate,
    ),
    orderBy: isPg
      ? [
          sql`${audits.startedAt} COLLATE "C" ASC`,
          sql`${audits.id} COLLATE "C" ASC`,
        ]
      : [asc(audits.startedAt), asc(audits.id)],
    columns: {
      id: true,
      workflowInstanceId: true,
      projectId: true,
      startedByUserId: true,
      startedAt: true,
      currentPhase: true,
      pagesCrawled: true,
      pagesTotal: true,
    },
    limit,
  });
}
