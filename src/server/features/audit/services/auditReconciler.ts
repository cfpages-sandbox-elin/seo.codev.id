/**
 * Reconciles audits stuck in "running" with the actual state of their
 * Cloudflare Workflow instance.
 */
import { env } from "cloudflare:workers";
import { and, asc, eq, isNotNull, isNull, not, sql } from "drizzle-orm";
import { db } from "@/db";
import { audits, projects } from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { parseUtcTimestampMs } from "@/server/features/fleet/services/fleetConstants";
import {
  classifyAuditError,
  type AuditErrorInfo,
} from "@/server/lib/audit/audit-errors";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  loadPersistedCursor,
  pgTimeExpr,
  savePersistedCursor,
  sqliteTimeExpr,
  type LoadedCursorState,
  type WatchdogCursor,
} from "./auditWatchdogCursor";

const INSTANCE_LOST_GRACE_MS = 10 * 60 * 1000;
const STALE_RUNNING_AFTER_MS = 15 * 60 * 1000;
const WATCHDOG_BATCH_LIMIT = 100;
const TICK_BUDGET_MS = 20_000;

type RunningAudit = {
  id: string;
  workflowInstanceId: string | null;
  startedAt: string;
  currentPhase: string | null;
};

let sweepCursor: WatchdogCursor = null;
let sweepInFlight = false;

/**
 * If the audit's workflow instance is dead (errored/terminated) or gone,
 * flip the row to failed with a classified error. Returns the error info
 * when the row was flipped, null when the audit is genuinely still running.
 */
export async function reconcileRunningAudit(
  audit: RunningAudit,
  probeTimeoutMs = 5000,
): Promise<AuditErrorInfo | null> {
  if (!audit.workflowInstanceId) return null;
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
        probeTimeoutMs,
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

/** Cron watchdog: sweep stale running audits and reconcile each within a single total tick deadline. */
export async function reconcileStaleAudits(overrideCursor?: WatchdogCursor) {
  if (sweepInFlight) {
    console.warn("[WATCHDOG] Overlapping tick suppressed.");
    return;
  }
  sweepInFlight = true;
  const deadline = Date.now() + TICK_BUDGET_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  try {
    const isManualOverride = overrideCursor !== undefined;
    const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS);
    const loaded: LoadedCursorState = isManualOverride
      ? { kind: "persisted", cursor: overrideCursor, revision: -1 }
      : await loadPersistedCursor();

    if (loaded.kind === "read_error") {
      console.warn(
        "[WATCHDOG] Failed to read persisted cursor state; skipping cursor sweep this cycle.",
      );
      return;
    }

    let currentRevision: number | null =
      loaded.kind === "persisted" ? loaded.revision : null;
    let activeCursor = loaded.cursor;

    if (remainingMs() < 2_000) return;

    // 1. Bounded sweep of legacy null-instance or non-canonical/invalid timestamp rows
    await reconcileIrregularRunningAudits(cutoff, remainingMs);

    if (remainingMs() < 2_000) return;

    // 2. Index-backed keyset sweep of canonical ISO-Z running audits (matching audits_running_keyset_idx)
    let stale = await getStaleRunningAudits(
      cutoff,
      WATCHDOG_BATCH_LIMIT,
      activeCursor,
    );

    if (stale.length === 0 && activeCursor !== null) {
      activeCursor = null;
      if (remainingMs() >= 2_000) {
        stale = await getStaleRunningAudits(cutoff, WATCHDOG_BATCH_LIMIT, null);
      }
    }

    let processedAll = true;
    for (let i = 0; i < stale.length; i += 5) {
      const budgetLeft = remainingMs();
      if (budgetLeft < 3_000) {
        console.warn(
          "Audit watchdog: tick deadline approaching, stopping batch early",
        );
        processedAll = false;
        break;
      }
      const groupProbeTimeout = Math.min(
        5_000,
        Math.max(500, budgetLeft - 2_000),
      );
      const group = stale.slice(i, i + 5);
      await Promise.allSettled(
        group.map(async (audit) => {
          try {
            const errorInfo = await reconcileRunningAudit(
              audit,
              groupProbeTimeout,
            );
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

      if (!isManualOverride && remainingMs() >= 500) {
        const last = group[group.length - 1];
        const nextCursor: WatchdogCursor = {
          startedAt: last.startedAt,
          id: last.id,
        };
        const saved = await savePersistedCursor(nextCursor, currentRevision);
        if (saved.result === "applied") {
          sweepCursor = nextCursor;
          currentRevision = saved.revision ?? currentRevision;
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
      !isManualOverride &&
      processedAll &&
      remainingMs() >= 500 &&
      (stale.length === 0 || stale.length < WATCHDOG_BATCH_LIMIT)
    ) {
      const wrapped = await savePersistedCursor(null, currentRevision);
      if (wrapped.result === "applied") {
        sweepCursor = null;
      }
    }
  } finally {
    sweepInFlight = false;
  }
}

async function reconcileIrregularRunningAudits(
  cutoff: Date,
  remainingMs: () => number,
) {
  const isPg = getDatabaseProvider() === "postgres";
  const isNullOrInvalid = isPg
    ? sql`(${audits.workflowInstanceId} IS NULL OR ${pgTimeExpr(audits.startedAt)} IS NULL OR ${audits.startedAt} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$')`
    : sql`(${audits.workflowInstanceId} IS NULL OR ${sqliteTimeExpr(audits.startedAt)} IS NULL OR NOT (${audits.startedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))`;

  try {
    const irregular = await db.query.audits.findMany({
      where: and(eq(audits.status, "running"), isNullOrInvalid),
      orderBy: isPg
        ? [sql`${audits.id} COLLATE "C" ASC`]
        : [sql`${audits.id} COLLATE BINARY ASC`],
      limit: 10,
      columns: {
        id: true,
        workflowInstanceId: true,
        startedAt: true,
        currentPhase: true,
      },
    });

    for (const row of irregular) {
      if (remainingMs() < 3_000) break;
      if (!row.workflowInstanceId) {
        const parsedMs = parseUtcTimestampMs(row.startedAt);
        if (!Number.isFinite(parsedMs) || parsedMs < cutoff.getTime()) {
          await AuditRepository.failAudit(row.id, null, {
            errorCode: "instance_lost",
            errorDetail: "Legacy running audit has null workflow instance ID",
            failedPhase: row.currentPhase,
          });
        }
        continue;
      }
      // Valid legacy space-UTC or unpadded ISO string: fail only if invalid or past cutoff
      const parsedMs = parseUtcTimestampMs(row.startedAt);
      if (!Number.isFinite(parsedMs)) {
        await AuditRepository.failAudit(row.id, row.workflowInstanceId, {
          errorCode: "invalid_started_at",
          errorDetail: "Running audit has malformed started_at timestamp",
          failedPhase: row.currentPhase,
        });
      } else if (parsedMs < cutoff.getTime()) {
        await reconcileRunningAudit(row, Math.min(3_000, remainingMs()));
      }
    }
  } catch (err) {
    console.error("Audit watchdog: irregular-row sweep failed:", err);
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

  // Strictly canonical 24-char .mmmZ rows match audits_running_keyset_idx (started_at, id) without temp sort.
  const canonicalFormat = isPg
    ? sql`${audits.startedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'`
    : sql`${audits.startedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`;

  const stalenessPredicate = isPg
    ? sql`((${audits.workflowInstanceId} NOT LIKE 'github-audit-%' AND ${audits.startedAt} < ${edgeCutoffIso}) OR (${audits.workflowInstanceId} LIKE 'github-audit-%' AND ${audits.startedAt} < ${repoCutoffIso}))`
    : sql`((${audits.workflowInstanceId} NOT LIKE 'github-audit-%' AND ${audits.startedAt} < ${edgeCutoffIso}) OR (${audits.workflowInstanceId} LIKE 'github-audit-%' AND ${audits.startedAt} < ${repoCutoffIso}))`;

  const cursorPredicate = cursor
    ? isPg
      ? sql`(${audits.startedAt} COLLATE "C" > ${cursor.startedAt} COLLATE "C" OR (${audits.startedAt} = ${cursor.startedAt} AND ${audits.id} COLLATE "C" > ${cursor.id} COLLATE "C"))`
      : sql`(${audits.startedAt} > ${cursor.startedAt} OR (${audits.startedAt} = ${cursor.startedAt} AND ${audits.id} > ${cursor.id}))`
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

function isOlderThan(startedAt: string, ageMs: number): boolean {
  const parsedMs = parseUtcTimestampMs(startedAt);
  if (!Number.isFinite(parsedMs)) return true;
  return parsedMs < Date.now() - ageMs;
}
