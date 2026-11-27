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
    WHEN substr(${expr}, 1, 4) > '0000'
     AND ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?$'
     AND pg_input_is_valid(${expr} || '+00', 'timestamptz')
    THEN (${expr} || '+00')::timestamptz
    WHEN substr(${expr}, 1, 4) > '0000'
     AND ${expr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?Z$'
     AND pg_input_is_valid(${expr}, 'timestamptz')
    THEN (${expr})::timestamptz
    ELSE NULL
  END
)`;

const sqliteDigits12 = (expr: SQL | Column | string | null | undefined) =>
  sql`(((substr(${expr}, 1, 4) || substr(${expr}, 6, 2)) || (substr(${expr}, 9, 2) || substr(${expr}, 12, 2))) || (substr(${expr}, 15, 2) || substr(${expr}, 18, 2)))`;

const sqliteCanonicalIsoCheck = (
  expr: SQL | Column | string | null | undefined,
) => sql`(
  ((instr(${expr}, char(0)) = 0 AND length(${expr}) = 24)
   AND (substr(${expr}, 1, 4) > '0000' AND (unicode(substr(${expr}, 11, 1)) = 84 AND unicode(substr(${expr}, 24, 1)) = 90)))
  AND (((((substr(${expr}, 5, 1) || substr(${expr}, 8, 1)) || (substr(${expr}, 14, 1) || substr(${expr}, 17, 1))) || substr(${expr}, 20, 1)) = '--::.')
   AND ((${sqliteDigits12(expr)} || substr(${expr}, 21, 3)) NOT GLOB '*[^0-9]*'
    AND (substr(${expr}, 12, 2) < '24' AND substr(${expr}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${expr}, 1, 19)))))
)`;

const sqliteTimeExpr = (expr: SQL | Column | string | null | undefined) => sql`(
  CASE
    WHEN (((instr(${expr}, char(0)) = 0 AND substr(${expr}, 1, 4) > '0000')
      AND (((substr(${expr}, 5, 1) || substr(${expr}, 8, 1)) || (substr(${expr}, 11, 1) || (substr(${expr}, 14, 1) || substr(${expr}, 17, 1)))) = '-- ::' AND ${sqliteDigits12(expr)} NOT GLOB '*[^0-9]*'))
     AND ((substr(${expr}, 12, 2) < '24' AND substr(${expr}, 1, 19) = strftime('%Y-%m-%d %H:%M:%S', substr(${expr}, 1, 19)))
      AND ((length(${expr}) = 19 OR ((length(${expr}) BETWEEN 21 AND 23) AND (substr(${expr}, 20, 1) = '.' AND substr(${expr}, 21) NOT GLOB '*[^0-9]*'))) AND julianday(${expr}) IS NOT NULL)))
    THEN julianday(${expr})
    WHEN (((instr(${expr}, char(0)) = 0 AND substr(${expr}, 1, 4) > '0000')
      AND ((length(${expr}) >= 20 AND unicode(substr(${expr}, length(${expr}), 1)) = 90)
       AND (unicode(substr(${expr}, 11, 1)) = 84 AND ((substr(${expr}, 5, 1) || substr(${expr}, 8, 1)) || (substr(${expr}, 14, 1) || substr(${expr}, 17, 1))) = '--::')))
     AND ((${sqliteDigits12(expr)} NOT GLOB '*[^0-9]*' AND substr(${expr}, 12, 2) < '24')
      AND (substr(${expr}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${expr}, 1, 19))
       AND ((length(${expr}) = 20 OR ((length(${expr}) BETWEEN 22 AND 24) AND (substr(${expr}, 20, 1) = '.' AND substr(${expr}, 21, length(${expr}) - 21) NOT GLOB '*[^0-9]*'))) AND julianday(${expr}) IS NOT NULL))))
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

/** Query actionable irregular running audits (null instance ID, invalid started_at, or non-canonical stale rows) so healthy fresh legacy rows never starve tail failures across cold starts (Sol R5, V4-03, V4-05). */
export async function findIrregularRunningAudits(
  limit: number,
  cursorId: string | null,
  cutoff?: Date,
): Promise<
  Array<{
    id: string;
    workflowInstanceId: string | null;
    startedAt: string;
    currentPhase: string | null;
  }>
>;
export async function findIrregularRunningAudits(
  limit: number,
  cursorId: string | null,
  cutoff = new Date(Date.now() - 15 * 60 * 1000),
) {
  const isPg = getDatabaseProvider() === "postgres";
  const edgeCutoffIso = cutoff.toISOString();
  const repoCutoffIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const isNullOrInvalid = isPg
    ? sql`(${audits.workflowInstanceId} IS NULL OR length(trim(${audits.workflowInstanceId})) = 0 OR ${pgTimeExpr(audits.startedAt)} IS NULL OR substr(${audits.startedAt}, 1, 4) <= '0000' OR (${audits.startedAt} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$' AND ((${audits.workflowInstanceId} NOT LIKE 'github-audit-%' AND ${pgTimeExpr(audits.startedAt)} < ${edgeCutoffIso}::timestamptz) OR (${audits.workflowInstanceId} LIKE 'github-audit-%' AND ${pgTimeExpr(audits.startedAt)} < ${repoCutoffIso}::timestamptz))))`
    : sql`((${audits.workflowInstanceId} IS NULL OR length(trim(${audits.workflowInstanceId})) = 0) OR (${sqliteTimeExpr(audits.startedAt)} IS NULL OR (NOT ${sqliteCanonicalIsoCheck(audits.startedAt)} AND ${sqliteTimeExpr(audits.startedAt)} < (CASE WHEN ${audits.workflowInstanceId} GLOB 'github-audit-*' THEN julianday(${repoCutoffIso}) ELSE julianday(${edgeCutoffIso}) END))))`;

  const cursorFilter = cursorId
    ? isPg
      ? sql`${audits.id} COLLATE "C" > ${cursorId}`
      : sql`${audits.id} COLLATE BINARY > ${cursorId}`
    : undefined;

  return db.query.audits.findMany({
    where: and(
      sql`${audits.status} = 'running'`,
      isNullOrInvalid,
      cursorFilter,
    ),
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

/** Query canonical ISO-Z stale running audits ordered by (started_at, id) keyset index (Sol R5, V4-03, V4-05). */
export async function getStaleRunningAudits(
  cutoff: Date,
  limit: number,
  cursor: WatchdogCursor,
) {
  const isPg = getDatabaseProvider() === "postgres";
  const edgeCutoffIso = cutoff.toISOString();
  const repoCutoffIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const canonicalFormat = isPg
    ? sql`substr(${audits.startedAt}, 1, 4) > '0000' AND ${audits.startedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$' AND ${pgTimeExpr(audits.startedAt)} IS NOT NULL`
    : sql`${sqliteCanonicalIsoCheck(audits.startedAt)} AND ${sqliteTimeExpr(audits.startedAt)} IS NOT NULL`;

  const stalenessPredicate = isPg
    ? sql`length(trim(${audits.workflowInstanceId})) > 0 AND ${audits.startedAt} COLLATE "C" < ${edgeCutoffIso} COLLATE "C" AND (${audits.workflowInstanceId} NOT LIKE 'github-audit-%' OR ${audits.startedAt} COLLATE "C" < ${repoCutoffIso} COLLATE "C")`
    : sql`length(trim(${audits.workflowInstanceId})) > 0 AND ${audits.startedAt} < ${edgeCutoffIso} AND (${audits.workflowInstanceId} NOT GLOB 'github-audit-*' OR ${audits.startedAt} < ${repoCutoffIso})`;

  const cursorPredicate = cursor
    ? isPg
      ? sql`(${audits.startedAt} COLLATE "C", ${audits.id} COLLATE "C") > (${cursor.startedAt} COLLATE "C", ${cursor.id} COLLATE "C")`
      : sql`(${audits.startedAt}, ${audits.id}) > (${cursor.startedAt}, ${cursor.id})`
    : undefined;

  return db.query.audits.findMany({
    where: and(
      sql`${audits.status} = 'running'`,
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
