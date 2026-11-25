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
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { audits, projects } from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  classifyAuditError,
  type AuditErrorInfo,
} from "@/server/lib/audit/audit-errors";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  loadPersistedCursor,
  pgBucketExpr,
  pgNormalizedTimeExpr,
  pgTimeExpr,
  savePersistedCursor,
  sqliteBucketExpr,
  sqliteNormalizedTimeExpr,
  type LoadedCursorState,
  type WatchdogCursor,
} from "./auditWatchdogCursor";

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

let sweepCursor: WatchdogCursor = null;

/**
 * If the audit's workflow instance is dead (errored/terminated) or gone,
 * flip the row to failed with a classified error. Returns the error info
 * when the row was flipped, null when the audit is genuinely still running.
 */
export async function reconcileRunningAudit(
  audit: RunningAudit,
): Promise<AuditErrorInfo | null> {
  if (!audit.workflowInstanceId) return null;
  // Sol P1-05, R3: Repository runner audits (workflow_instance_id LIKE 'github-audit-%') run out-of-band.
  // If running longer than 2 hours, reclaim the abandoned reservation without querying Cloudflare Workflows.
  if (audit.workflowInstanceId.startsWith("github-audit-")) {
    const GITHUB_AUDIT_TTL_MS = 2 * 60 * 60 * 1000;
    if (!isOlderThan(audit.startedAt, GITHUB_AUDIT_TTL_MS)) return null;
    const errorInfo: AuditErrorInfo = {
      errorCode: "runner_timeout",
      errorDetail:
        "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
    };
    const failed = await AuditRepository.failAudit(
      audit.id,
      audit.workflowInstanceId,
      {
        errorCode: errorInfo.errorCode,
        errorDetail: errorInfo.errorDetail,
        failedPhase: audit.currentPhase ?? "analyzing",
      },
    );
    return failed ? errorInfo : null;
  }

  let errorInfo: AuditErrorInfo | null = null;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const probePromise = (async () => {
      const instance = await env.SITE_AUDIT_WORKFLOW.get(
        audit.workflowInstanceId!,
      );
      return instance.status();
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error("Workflow probe timed out")),
        5000,
      );
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
    // Transient status/control-plane errors must NOT fail a live audit; only confirmed not-found counts.
    const message = error instanceof Error ? error.message : String(error);
    if (!/not[ _]?found/i.test(message)) return null;
    if (!isOlderThan(audit.startedAt, INSTANCE_LOST_GRACE_MS)) return null;
    errorInfo = {
      errorCode: "instance_lost",
      errorDetail: "Workflow instance not found",
    };
  } finally {
    if (timerId) clearTimeout(timerId);
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
  return didFail ? errorInfo : null;
}

/** Cron watchdog: sweep stale running audits and reconcile each. */
export async function reconcileStaleAudits(overrideCursor?: WatchdogCursor) {
  const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS);
  const loaded: LoadedCursorState =
    overrideCursor !== undefined
      ? { kind: "persisted", cursor: overrideCursor, revision: -1 }
      : await loadPersistedCursor();

  if (loaded.kind === "read_error") {
    console.warn(
      "[WATCHDOG] Failed to read persisted cursor state; skipping cursor sweep this cycle.",
    );
    return;
  }

  let activeCursor = loaded.cursor;
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

  // Reconcile legacy running rows with NULL workflow_instance_id older than cutoff
  const isPg = getDatabaseProvider() === "postgres";
  const cutoffIso = cutoff.toISOString();
  const nullTimestampPredicate = isPg
    ? sql`(${pgTimeExpr(audits.startedAt)} IS NULL OR ${pgTimeExpr(audits.startedAt)} < ${cutoffIso}::timestamptz)`
    : sql`(julianday(${audits.startedAt}) IS NULL OR julianday(${audits.startedAt}) < julianday(${cutoffIso}))`;

  try {
    const nullInstanceAudits = await db.query.audits.findMany({
      where: and(
        eq(audits.status, "running"),
        isNull(audits.workflowInstanceId),
        nullTimestampPredicate,
      ),
      orderBy: isPg
        ? [
            sql`${pgTimeExpr(audits.startedAt)} ASC NULLS FIRST`,
            sql`${audits.id} COLLATE "C" ASC`,
          ]
        : [
            sql`julianday(${audits.startedAt}) ASC`,
            sql`${audits.id} COLLATE BINARY ASC`,
          ],
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
  } catch (err) {
    console.error("Audit watchdog: legacy null-instance sweep failed:", err);
  }

  const deadline = Date.now() + 20_000;
  let currentRevision = loaded.revision;
  let processedAll = true;

  for (let i = 0; i < stale.length; i += 5) {
    if (Date.now() + 5_000 > deadline) {
      console.warn(
        "Audit watchdog: tick deadline approaching, stopping batch early",
      );
      processedAll = false;
      break;
    }
    const group = stale.slice(i, i + 5);
    await Promise.allSettled(
      group.map(async (audit) => {
        try {
          const errorInfo = await reconcileRunningAudit(audit);
          if (!errorInfo) return;

          console.log(
            `Audit watchdog: marked ${audit.id} failed (${errorInfo.errorCode}, phase=${audit.currentPhase})`,
          );
          const project = await db.query.projects.findFirst({
            where: eq(projects.id, audit.projectId),
          });
          if (!project) return;
          captureServerEvent({
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
          }).catch(() => {});
        } catch (error) {
          console.error(
            `Audit watchdog: failed to reconcile ${audit.id}:`,
            error,
          );
        }
      }),
    );

    if (currentRevision !== null && currentRevision !== -1) {
      const last = group[group.length - 1];
      const nextCursor: WatchdogCursor = {
        startedAt: last.startedAt,
        id: last.id,
      };
      const saved = await savePersistedCursor(nextCursor, currentRevision);
      if (saved.result === "applied") {
        sweepCursor = nextCursor;
        currentRevision++;
      } else {
        console.warn(
          `Audit watchdog: cursor save yielded '${saved.result}', halting advance`,
        );
        processedAll = false;
        break;
      }
    }
  }

  if (
    processedAll &&
    currentRevision !== null &&
    currentRevision !== -1 &&
    (stale.length === 0 || stale.length < WATCHDOG_BATCH_LIMIT)
  ) {
    const wrapped = await savePersistedCursor(null, currentRevision);
    if (wrapped.result === "applied") {
      sweepCursor = null;
    }
  }
}

async function getStaleRunningAudits(
  cutoff: Date,
  limit: number,
  cursor: WatchdogCursor = sweepCursor,
) {
  const isPg = getDatabaseProvider() === "postgres";
  const edgeCutoffIso = cutoff.toISOString();
  const repoCutoffIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const stalenessPredicate = isPg
    ? sql`(((${audits.workflowInstanceId} NOT LIKE 'github-audit-%' AND (${pgTimeExpr(audits.startedAt)} IS NULL OR ${pgTimeExpr(audits.startedAt)} < ${edgeCutoffIso}::timestamptz)) OR (${audits.workflowInstanceId} LIKE 'github-audit-%' AND (${pgTimeExpr(audits.startedAt)} IS NULL OR ${pgTimeExpr(audits.startedAt)} < ${repoCutoffIso}::timestamptz))))`
    : sql`(((${audits.workflowInstanceId} NOT LIKE 'github-audit-%' AND (julianday(${audits.startedAt}) IS NULL OR julianday(${audits.startedAt}) < julianday(${edgeCutoffIso}))) OR (${audits.workflowInstanceId} LIKE 'github-audit-%' AND (julianday(${audits.startedAt}) IS NULL OR julianday(${audits.startedAt}) < julianday(${repoCutoffIso})))))`;

  const cursorPredicate = cursor
    ? isPg
      ? sql`(
          ${pgBucketExpr(audits.startedAt)} > ${pgBucketExpr(cursor.startedAt)}
          OR (${pgBucketExpr(audits.startedAt)} = ${pgBucketExpr(cursor.startedAt)} AND ${pgNormalizedTimeExpr(audits.startedAt)} > ${pgNormalizedTimeExpr(cursor.startedAt)})
          OR (${pgBucketExpr(audits.startedAt)} = ${pgBucketExpr(cursor.startedAt)} AND ${pgNormalizedTimeExpr(audits.startedAt)} = ${pgNormalizedTimeExpr(cursor.startedAt)} AND ${audits.id} COLLATE "C" > ${cursor.id} COLLATE "C")
        )`
      : sql`(
          ${sqliteBucketExpr(audits.startedAt)} > ${sqliteBucketExpr(cursor.startedAt)}
          OR (${sqliteBucketExpr(audits.startedAt)} = ${sqliteBucketExpr(cursor.startedAt)} AND ${sqliteNormalizedTimeExpr(audits.startedAt)} > ${sqliteNormalizedTimeExpr(cursor.startedAt)})
          OR (${sqliteBucketExpr(audits.startedAt)} = ${sqliteBucketExpr(cursor.startedAt)} AND ${sqliteNormalizedTimeExpr(audits.startedAt)} = ${sqliteNormalizedTimeExpr(cursor.startedAt)} AND ${audits.id} COLLATE BINARY > ${cursor.id} COLLATE BINARY)
        )`
    : undefined;

  return db.query.audits.findMany({
    where: and(
      eq(audits.status, "running"),
      isNotNull(audits.workflowInstanceId),
      stalenessPredicate,
      cursorPredicate,
    ),
    orderBy: isPg
      ? [
          sql`${pgBucketExpr(audits.startedAt)} ASC`,
          sql`${pgNormalizedTimeExpr(audits.startedAt)} ASC`,
          sql`${audits.id} COLLATE "C" ASC`,
        ]
      : [
          sql`${sqliteBucketExpr(audits.startedAt)} ASC`,
          sql`${sqliteNormalizedTimeExpr(audits.startedAt)} ASC`,
          sql`${audits.id} COLLATE BINARY ASC`,
        ],
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
  const parsed = Date.parse(
    startedAt.includes("T") ? startedAt : `${startedAt.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(parsed)) return true;
  return parsed < Date.now() - ageMs;
}
