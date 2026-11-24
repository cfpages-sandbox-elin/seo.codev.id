/**
 * Reconciles audits stuck in "running" with the actual state of their
 * Cloudflare Workflow instance.
 *
 * A workflow killed by the platform (OOM, CPU limit, deploy reset) never
 * reaches its own mark-failed step, and an instance can expire from Workflows
 * retention entirely. Two callers close that gap:
 *   - AuditService.getStatus (lazy: whenever the UI polls a running audit)
 *   - the scheduled watchdog (reconcileStaleAudits, every cron tick) — so
 *     zombie rows die even if nobody ever reopens the page, and the instance
 *     error is copied into the row before Workflows retention deletes it.
 */
import { env } from "cloudflare:workers";
import { and, asc, eq, isNotNull, isNull, notLike, sql } from "drizzle-orm";
import { db } from "@/db";
import { audits, projects, watchdogCursor } from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  classifyAuditError,
  type AuditErrorInfo,
} from "@/server/lib/audit/audit-errors";
import { captureServerEvent } from "@/server/lib/posthog";

/**
 * Don't declare an instance "lost" until the audit is comfortably older than
 * any legitimate create/start delay: startAudit inserts the row before
 * creating the workflow, so a brand-new audit can briefly have no instance.
 */
const INSTANCE_LOST_GRACE_MS = 10 * 60 * 1000;

/** Audits still "running" after this long get reconciled by the watchdog. */
const STALE_RUNNING_AFTER_MS = 15 * 60 * 1000;

const WATCHDOG_BATCH_LIMIT = 100;

type RunningAudit = {
  id: string;
  workflowInstanceId: string | null;
  startedAt: string;
  currentPhase: string | null;
};

/**
 * If the audit's workflow instance is dead (errored/terminated) or gone,
 * flip the row to failed with a classified error. Returns the error info
 * when the row was flipped, null when the audit is genuinely still running.
 */
export async function reconcileRunningAudit(
  audit: RunningAudit,
): Promise<AuditErrorInfo | null> {
  if (!audit.workflowInstanceId) return null;
  // Sol P1-05, R3: Repository runner audits (workflow_instance_id LIKE 'github-audit-%') are executed out-of-band by the CLI runner.
  // If running longer than 2 hours, reclaim the abandoned reservation without querying Cloudflare Workflows.
  if (audit.workflowInstanceId.startsWith("github-audit-")) {
    const startedAtMs = new Date(audit.startedAt).getTime();
    const GITHUB_AUDIT_TTL_MS = 2 * 60 * 60 * 1000;
    if (Date.now() - startedAtMs > GITHUB_AUDIT_TTL_MS) {
      const errorInfo: AuditErrorInfo = {
        errorCode: "runner_timeout",
        errorDetail:
          "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
      };
      await AuditRepository.failAudit(
        audit.id,
        audit.workflowInstanceId,
        {
          errorCode: errorInfo.errorCode,
          errorDetail: errorInfo.errorDetail,
          failedPhase: audit.currentPhase ?? "analyzing",
        },
      );
      return errorInfo;
    }
    return null;
  }

  let errorInfo: AuditErrorInfo | null = null;
  try {
    const probePromise = (async () => {
      const instance = await env.SITE_AUDIT_WORKFLOW.get(
        audit.workflowInstanceId!,
      );
      return instance.status();
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Workflow probe timed out")), 5000);
    });

    const status = await Promise.race([probePromise, timeoutPromise]);
    if (status.status === "errored" || status.status === "terminated") {
      errorInfo = status.error
        ? classifyAuditError(
            typeof status.error === "string"
              ? status.error
              : (status.error.message ?? JSON.stringify(status.error)),
          )
        : {
            errorCode: "unknown",
            errorDetail: `Workflow instance ${status.status}`,
          };
    } else if (status.status === "complete") {
      errorInfo = {
        errorCode: "workflow_completed_without_finalization",
        errorDetail:
          "Workflow instance completed without marking audit record terminal",
      };
    }
  } catch (error) {
    // Instance not found (never created, or expired from Workflows
    // retention). Past the grace window that means the audit can never
    // finish — without this branch such rows stay "running" forever.
    // Transient status/control-plane errors must NOT fail a live audit,
    // so only a confirmed not-found counts.
    const message = error instanceof Error ? error.message : String(error);
    if (!/not[ _]?found/i.test(message)) return null;
    if (!isOlderThan(audit.startedAt, INSTANCE_LOST_GRACE_MS)) return null;
    errorInfo = {
      errorCode: "instance_lost",
      errorDetail: "Workflow instance not found",
    };
  }
  if (!errorInfo) return null;

  const didFail = await AuditRepository.failAudit(
    audit.id,
    audit.workflowInstanceId,
    {
      ...errorInfo,
      failedPhase: audit.currentPhase,
    },
  );
  if (!didFail) return null;
  return errorInfo;
}

type WatchdogCursor = {
  startedAt: string;
  id: string;
} | null;

let sweepCursor: WatchdogCursor = null;

async function loadPersistedCursor(): Promise<WatchdogCursor> {
  try {
    const row = await db.query.watchdogCursor.findFirst({
      where: eq(watchdogCursor.id, "singleton"),
    });
    if (row && row.startedAt && row.auditId) {
      return { startedAt: row.startedAt, id: row.auditId };
    }
  } catch {}
  return sweepCursor;
}

async function savePersistedCursor(cursor: WatchdogCursor): Promise<void> {
  sweepCursor = cursor;
  try {
    const isPg = getDatabaseProvider() === "postgres";
    const nowIso = new Date().toISOString();
    const existing = await db.query.watchdogCursor.findFirst({
      where: eq(watchdogCursor.id, "singleton"),
    });

    if (existing) {
      await db
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
        );
    } else {
      await db
        .insert(watchdogCursor)
        .values({
          id: "singleton",
          startedAt: cursor ? cursor.startedAt : null,
          auditId: cursor ? cursor.id : null,
          revision: 1,
        })
        .onConflictDoNothing();
    }
  } catch {}
}

/** Cron watchdog: sweep stale running audits and reconcile each. */
export async function reconcileStaleAudits(overrideCursor?: WatchdogCursor) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS);
  let activeCursor =
    overrideCursor !== undefined ? overrideCursor : await loadPersistedCursor();
  let stale = await getStaleRunningAudits(
    cutoff,
    WATCHDOG_BATCH_LIMIT,
    activeCursor,
  );

  // Sol R1: If bounded keyset reached the end, wrap around to the beginning
  if (stale.length === 0 && activeCursor !== null) {
    activeCursor = null;
    stale = await getStaleRunningAudits(cutoff, WATCHDOG_BATCH_LIMIT, null);
  }

  // Update cursor for next sweep
  if (stale.length > 0) {
    const last = stale[stale.length - 1];
    await savePersistedCursor({ startedAt: last.startedAt, id: last.id });
  } else {
    await savePersistedCursor(null);
  }

  // Reconcile legacy running rows with NULL workflow_instance_id that are older than cutoff
  // (Sol R1: "Handle historical null IDs via a separately scoped recovery rule.")
  const isPg = getDatabaseProvider() === "postgres";
  const cutoffIso = cutoff.toISOString();
  const nullTimestampPredicate = isPg
    ? sql`${audits.startedAt}::timestamptz < ${cutoffIso}::timestamptz`
    : sql`julianday(${audits.startedAt}) < julianday(${cutoffIso})`;

  try {
    const nullInstanceAudits = await db.query.audits.findMany({
      where: and(
        eq(audits.status, "running"),
        isNull(audits.workflowInstanceId),
        nullTimestampPredicate,
      ),
      orderBy: [asc(audits.startedAt), asc(audits.id)],
      limit: 20,
      columns: {
        id: true,
        currentPhase: true,
      },
    });

    for (const legacy of nullInstanceAudits) {
      await AuditRepository.failAudit(legacy.id, null, {
        errorCode: "instance_lost",
        errorDetail: "Legacy running audit has null workflow instance ID",
        failedPhase: legacy.currentPhase,
      });
    }
  } catch {}

  for (const audit of stale) {
    try {
      const errorInfo = await reconcileRunningAudit(audit);
      if (!errorInfo) continue;

      console.log(
        `Audit watchdog: marked ${audit.id} failed (${errorInfo.errorCode}, phase=${audit.currentPhase})`,
      );
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, audit.projectId),
      });
      if (!project) continue;
      await captureServerEvent({
        distinctId: audit.startedByUserId,
        event: "site_audit:complete",
        organizationId: project.organizationId,
        properties: {
          project_id: audit.projectId,
          status: "failed",
          reconciled_by: "watchdog",
          error_code: errorInfo.errorCode,
          pages_crawled: audit.pagesCrawled,
          pages_total: audit.pagesTotal,
        },
      });
    } catch (error) {
      // One unreconcilable audit must not stop the sweep.
      console.error(`Audit watchdog: failed to reconcile ${audit.id}:`, error);
    }
  }
}

/**
 * Running audits started before the cutoff — watchdog candidates. Timestamps
 * are stored as text, so this compares lexicographically: PG rows use ISO
 * with a "T", D1-default rows use "YYYY-MM-DD HH:MM:SS" (space < "T", so a
 * same-day ISO cutoff would misorder against D1 rows without the reformat).
 * Sol R1: Uses (startedAt, id) keyset pagination and tiebreaker so later stranded rows
 * are never starved by earlier stalled rows.
 */
async function getStaleRunningAudits(
  cutoff: Date,
  limit: number,
  cursor: WatchdogCursor = sweepCursor,
) {
  const isPg = getDatabaseProvider() === "postgres";
  const cutoffIso = cutoff.toISOString();
  const timestampPredicate = isPg
    ? sql`${audits.startedAt}::timestamptz < ${cutoffIso}::timestamptz`
    : sql`julianday(${audits.startedAt}) < julianday(${cutoffIso})`;

  const cursorPredicate = cursor
    ? isPg
      ? sql`(${audits.startedAt}::timestamptz > ${cursor.startedAt}::timestamptz OR (${audits.startedAt}::timestamptz = ${cursor.startedAt}::timestamptz AND ${audits.id} > ${cursor.id}))`
      : sql`(julianday(${audits.startedAt}) > julianday(${cursor.startedAt}) OR (julianday(${audits.startedAt}) = julianday(${cursor.startedAt}) AND ${audits.id} > ${cursor.id}))`
    : undefined;

  return db.query.audits.findMany({
    where: and(
      eq(audits.status, "running"),
      isNotNull(audits.workflowInstanceId),
      notLike(audits.workflowInstanceId, "github-audit-%"),
      timestampPredicate,
      cursorPredicate,
    ),
    orderBy: isPg
      ? [sql`${audits.startedAt}::timestamptz ASC`, sql`${audits.id} ASC`]
      : [sql`julianday(${audits.startedAt}) ASC`, sql`${audits.id} ASC`],
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

function isOlderThan(startedAt: string, ageMs: number): boolean {
  // D1-default timestamps ("YYYY-MM-DD HH:MM:SS") lack the T/Z; normalize so
  // Date.parse reads them as UTC, matching the PG ISO format.
  const parsed = Date.parse(
    startedAt.includes("T") ? startedAt : `${startedAt.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(parsed)) return true;
  return parsed < Date.now() - ageMs;
}
