/**
 * Reconciles audits stuck in "running" with the actual state of their
 * Cloudflare Workflow instance.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { parseUtcTimestampMs } from "@/server/features/fleet/services/fleetConstants";
import {
  classifyAuditError,
  type AuditErrorInfo,
} from "@/server/lib/audit/audit-errors";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  getStaleRunningAudits,
  loadPersistedCursor,
  savePersistedCursor,
  type LoadedCursorState,
  type WatchdogCursor,
} from "./auditWatchdogCursor";
import { reconcileIrregularRunningAudits } from "./auditIrregularSweep";

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

let sweepInFlight = false;
let currentSweepToken = 0;

function withTickTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(
      new Error(`Watchdog tick budget exhausted before ${label}`),
    );
  }
  let timerId: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timerId = setTimeout(
      () =>
        reject(
          new Error(
            `Watchdog ${label} exceeded remaining tick budget (${timeoutMs}ms)`,
          ),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => {
        if (timerId !== undefined) clearTimeout(timerId);
        resolve(value);
      },
      (err) => {
        if (timerId !== undefined) clearTimeout(timerId);
        reject(err);
      },
    );
  });
}

/**
 * If the audit's workflow instance is dead (errored/terminated) or gone,
 * flip the row to failed with a classified error. Returns the error info
 * when the row was flipped, null when the audit is genuinely still running.
 */
export async function reconcileRunningAudit(
  audit: RunningAudit,
  probeTimeoutMs = 5000,
  remainingMs: () => number = () => probeTimeoutMs,
  isActive: () => boolean = () => true,
): Promise<AuditErrorInfo | null> {
  if (!audit.workflowInstanceId) return null;
  if (!isActive() || remainingMs() < 250) return null;
  if (audit.workflowInstanceId.startsWith("github-audit-")) {
    const GITHUB_AUDIT_TTL_MS = 2 * 60 * 60 * 1000;
    if (!isOlderThan(audit.startedAt, GITHUB_AUDIT_TTL_MS)) return null;
    const errorInfo: AuditErrorInfo = {
      errorCode: "runner_timeout",
      errorDetail:
        "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
    };
    const failed = await withTickTimeout(
      AuditRepository.failAudit(audit.id, audit.workflowInstanceId, {
        errorCode: errorInfo.errorCode,
        errorDetail: errorInfo.errorDetail,
        failedPhase: audit.currentPhase ?? "analyzing",
      }),
      Math.min(probeTimeoutMs, remainingMs()),
      "failGithubAudit",
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
  if (!errorInfo || !isActive() || remainingMs() < 250) return null;

  const didFail = await withTickTimeout(
    AuditRepository.failAudit(audit.id, audit.workflowInstanceId, {
      ...errorInfo,
      failedPhase: audit.currentPhase,
    }),
    Math.min(probeTimeoutMs, remainingMs()),
    "failAudit",
  );
  return didFail ? errorInfo : null;
}

/** Cron watchdog: sweep stale running audits and reconcile each within a strict total tick deadline (Sol R4, R5). */
export async function reconcileStaleAudits(overrideCursor?: WatchdogCursor) {
  if (sweepInFlight) {
    console.warn("[WATCHDOG] Overlapping tick suppressed.");
    return;
  }
  sweepInFlight = true;
  const myToken = ++currentSweepToken;
  const deadline = Date.now() + TICK_BUDGET_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const isActive = () => myToken === currentSweepToken && remainingMs() > 0;

  const runSweep = async () => {
    const isManualOverride = overrideCursor !== undefined;
    const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS);
    const loaded: LoadedCursorState = isManualOverride
      ? { kind: "persisted", cursor: overrideCursor, revision: -1 }
      : await withTickTimeout(
          loadPersistedCursor(),
          remainingMs(),
          "loadPersistedCursor",
        );

    if (!isActive() || loaded.kind === "read_error") {
      if (loaded.kind === "read_error") {
        console.warn(
          "[WATCHDOG] Failed to read persisted cursor state; skipping cursor sweep this cycle.",
        );
      }
      return;
    }

    let currentRevision: number | null =
      loaded.kind === "persisted" ? loaded.revision : null;
    let activeCursor = loaded.cursor;

    if (remainingMs() < 2_000) return;

    // 1. Progressing cursor sweep of legacy null-instance or non-canonical/invalid timestamp rows
    await reconcileIrregularRunningAudits(
      cutoff,
      remainingMs,
      isActive,
      withTickTimeout,
      reconcileRunningAudit,
    );

    if (!isActive() || remainingMs() < 2_000) return;

    // 2. Index-backed keyset sweep of canonical ISO-Z running audits (matching audits_running_keyset_idx)
    let stale = await withTickTimeout(
      getStaleRunningAudits(cutoff, WATCHDOG_BATCH_LIMIT, activeCursor),
      remainingMs(),
      "getStaleRunningAudits",
    );
    if (!isActive()) return;

    if (stale.length === 0 && activeCursor !== null) {
      activeCursor = null;
      if (remainingMs() >= 2_000) {
        stale = await withTickTimeout(
          getStaleRunningAudits(cutoff, WATCHDOG_BATCH_LIMIT, null),
          remainingMs(),
          "getStaleRunningAuditsWrap",
        );
      }
    }
    if (!isActive()) return;

    let processedAll = true;
    for (let i = 0; i < stale.length; i += 5) {
      const budgetLeft = remainingMs();
      if (!isActive() || budgetLeft < 3_000) {
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
      await withTickTimeout(
        Promise.allSettled(
          group.map(async (audit) => {
            try {
              const errorInfo = await reconcileRunningAudit(
                audit,
                groupProbeTimeout,
                remainingMs,
                isActive,
              );
              if (!errorInfo || !isActive()) return;

              console.log(
                `Audit watchdog: marked ${audit.id} failed (${errorInfo.errorCode}, phase=${audit.currentPhase})`,
              );
              const project = await withTickTimeout(
                db.query.projects.findFirst({
                  where: eq(projects.id, audit.projectId),
                }),
                remainingMs(),
                "lookupProject",
              );
              if (!project || !isActive()) return;
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
        ),
        remainingMs(),
        "reconcileGroup",
      );

      if (!isManualOverride && isActive() && remainingMs() >= 500) {
        const last = group[group.length - 1];
        const nextCursor: WatchdogCursor = {
          startedAt: last.startedAt,
          id: last.id,
        };
        const saved = await withTickTimeout(
          savePersistedCursor(nextCursor, currentRevision),
          remainingMs(),
          "savePersistedCursor",
        );
        if (!isActive()) return;
        if (saved.result === "applied") {
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
      isActive() &&
      processedAll &&
      remainingMs() >= 500 &&
      (stale.length === 0 || stale.length < WATCHDOG_BATCH_LIMIT)
    ) {
      await withTickTimeout(
        savePersistedCursor(null, currentRevision),
        remainingMs(),
        "wrapPersistedCursor",
      );
    }
  };

  try {
    await withTickTimeout(runSweep(), TICK_BUDGET_MS, "sweep");
  } catch (err) {
    if (err instanceof Error && err.message.includes("Watchdog")) {
      console.warn(err.message);
    } else {
      throw err;
    }
  } finally {
    if (myToken === currentSweepToken) {
      currentSweepToken++;
      sweepInFlight = false;
    }
  }
}

function isOlderThan(startedAt: string, ageMs: number): boolean {
  const parsedMs = parseUtcTimestampMs(startedAt);
  if (!Number.isFinite(parsedMs)) return true;
  return parsedMs < Date.now() - ageMs;
}
