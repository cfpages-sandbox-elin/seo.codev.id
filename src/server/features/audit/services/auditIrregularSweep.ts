import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { parseUtcTimestampMs } from "@/server/features/fleet/services/fleetConstants";
import { type AuditErrorInfo } from "@/server/lib/audit/audit-errors";
import { findIrregularRunningAudits } from "./auditWatchdogCursor";

type RunningAuditRef = {
  id: string;
  workflowInstanceId: string | null;
  startedAt: string;
  currentPhase: string | null;
};

let irregularCursorId: string | null = null;

type IrregularSweepContext = {
  cutoffMs: number;
  remainingMs: () => number;
  isActive: () => boolean;
  withTimeout: <T>(p: Promise<T>, ms: number, label: string) => Promise<T>;
  reconcileRow: (
    audit: RunningAuditRef,
    probeTimeoutMs?: number,
    remainingMs?: () => number,
    isActive?: () => boolean,
  ) => Promise<AuditErrorInfo | null>;
};

async function reconcileOneIrregularRow(
  row: RunningAuditRef,
  ctx: IrregularSweepContext,
): Promise<"done" | "budget_exhausted"> {
  const { cutoffMs, remainingMs, isActive, withTimeout, reconcileRow } = ctx;
  if (!isActive() || remainingMs() < 250) return "budget_exhausted";
  const parsedMs = parseUtcTimestampMs(row.startedAt);
  if (!row.workflowInstanceId) {
    if (!Number.isFinite(parsedMs) || parsedMs < cutoffMs) {
      await withTimeout(
        AuditRepository.failAudit(row.id, null, {
          errorCode: "instance_lost",
          errorDetail: "Legacy running audit has null workflow instance ID",
          failedPhase: row.currentPhase,
        }),
        Math.min(3_000, remainingMs()),
        "failIrregularNullInstance",
      );
    }
    return "done";
  }
  if (!Number.isFinite(parsedMs)) {
    await withTimeout(
      AuditRepository.failAudit(row.id, row.workflowInstanceId, {
        errorCode: "invalid_started_at",
        errorDetail: "Running audit has malformed started_at timestamp",
        failedPhase: row.currentPhase,
      }),
      Math.min(3_000, remainingMs()),
      "failIrregularInvalidStartedAt",
    );
    return "done";
  }
  if (parsedMs < cutoffMs) {
    await reconcileRow(
      row,
      Math.min(3_000, remainingMs()),
      remainingMs,
      isActive,
    );
  }
  return "done";
}

/** Progressing keyset sweep of null-instance or non-canonical/invalid started_at running rows (Sol R5, V4-01). */
export async function reconcileIrregularRunningAudits(
  cutoff: Date,
  remainingMs: () => number,
  isActive: () => boolean,
  withTimeout: <T>(p: Promise<T>, ms: number, label: string) => Promise<T>,
  reconcileRow: (
    audit: RunningAuditRef,
    probeTimeoutMs?: number,
    remainingMs?: () => number,
    isActive?: () => boolean,
  ) => Promise<AuditErrorInfo | null>,
) {
  try {
    let irregular = await withTimeout(
      findIrregularRunningAudits(10, irregularCursorId),
      remainingMs(),
      "findIrregularAudits",
    );
    if (!isActive()) return;

    if (irregular.length === 0 && irregularCursorId !== null) {
      irregularCursorId = null;
      if (remainingMs() >= 2_000) {
        irregular = await withTimeout(
          findIrregularRunningAudits(10, null),
          remainingMs(),
          "findIrregularAuditsWrap",
        );
      }
    }
    if (!isActive()) return;

    let lastAttemptedId: string | null = null;
    let brokeEarly = false;
    for (const row of irregular) {
      if (!isActive() || remainingMs() < 3_000) {
        brokeEarly = true;
        break;
      }
      try {
        const res = await reconcileOneIrregularRow(row, {
          cutoffMs: cutoff.getTime(),
          remainingMs,
          isActive,
          withTimeout,
          reconcileRow,
        });
        if (res === "budget_exhausted") {
          brokeEarly = true;
          break;
        }
        lastAttemptedId = row.id;
      } catch (rowErr) {
        lastAttemptedId = row.id;
        console.error(
          `Audit watchdog: irregular row ${row.id} reconciliation failed:`,
          rowErr,
        );
      }
    }

    if (isActive()) {
      irregularCursorId =
        !brokeEarly && irregular.length < 10
          ? null
          : (lastAttemptedId ?? irregularCursorId);
    }
  } catch (err) {
    console.error("Audit watchdog: irregular-row sweep failed:", err);
  }
}
