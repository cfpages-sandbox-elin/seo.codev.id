import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  failAudit: vi.fn(),
  findIrregularRunningAudits: vi.fn(),
  getStaleRunningAudits: vi.fn(),
  loadPersistedCursor: vi.fn(),
  savePersistedCursor: vi.fn(),
  workflowGet: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    SITE_AUDIT_WORKFLOW: {
      get: mocks.workflowGet,
    },
  },
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      projects: {
        findFirst: vi.fn(async () => null),
      },
    },
  },
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    failAudit: mocks.failAudit,
  },
}));

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(async () => {}),
}));

vi.mock("./auditWatchdogCursor", () => ({
  findIrregularRunningAudits: mocks.findIrregularRunningAudits,
  getStaleRunningAudits: mocks.getStaleRunningAudits,
  loadPersistedCursor: mocks.loadPersistedCursor,
  savePersistedCursor: mocks.savePersistedCursor,
}));

import { parseUtcTimestampMs } from "@/server/features/fleet/services/fleetConstants";
import { reconcileRunningAudit, reconcileStaleAudits } from "./auditReconciler";

describe("auditReconciler hardening (V4-01, V4-03, V4-04)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPersistedCursor.mockResolvedValue({
      kind: "persisted",
      cursor: null,
      revision: 1,
    });
    mocks.findIrregularRunningAudits.mockResolvedValue([]);
    mocks.getStaleRunningAudits.mockResolvedValue([]);
    mocks.savePersistedCursor.mockResolvedValue({
      result: "applied",
      revision: 2,
      cursor: null,
    });
  });

  it("isolates per-row irregular sweep failures so broken row i00 neither blocks i01..i09 nor stalls cursor advance (V4-01)", async () => {
    const batch1 = Array.from({ length: 10 }, (_, idx) => ({
      id: `irr_${String(idx).padStart(2, "0")}`,
      workflowInstanceId: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      currentPhase: "crawling",
    }));

    mocks.findIrregularRunningAudits.mockResolvedValueOnce(batch1);
    mocks.failAudit.mockImplementation(async (id: string) => {
      if (id === "irr_00") {
        throw new Error("Simulated transient D1 failure on irr_00");
      }
      return true;
    });

    await reconcileStaleAudits();

    expect(mocks.failAudit).toHaveBeenCalledTimes(10);
    expect(mocks.failAudit.mock.calls.map((c) => String(c[0]))).toEqual(
      batch1.map((b) => b.id),
    );

    // Next tick must resume from irr_09 rather than getting stuck at null or skipping past irr_09
    mocks.findIrregularRunningAudits.mockResolvedValueOnce([]);
    await reconcileStaleAudits();
    expect(mocks.findIrregularRunningAudits).toHaveBeenNthCalledWith(
      2,
      10,
      "irr_09",
      expect.any(Date),
    );
  });

  it("rejects year-0000, lowercase z, and NUL-byte UTC timestamps cleanly (V4-03)", () => {
    expect(parseUtcTimestampMs("0000-01-01T00:00:00Z")).toBeNaN();
    expect(parseUtcTimestampMs("0000-01-01 00:00:00")).toBeNaN();
    expect(parseUtcTimestampMs("2026-01-01T12:00:00.000z")).toBeNaN();
    expect(parseUtcTimestampMs("2026-01-01T12:00:00.000Z\0")).toBeNaN();
    expect(parseUtcTimestampMs("2026-01-01 12:00:00\0")).toBeNaN();
    expect(parseUtcTimestampMs("2026-01-01T12:00:00.123Z")).toBe(
      Date.parse("2026-01-01T12:00:00.123Z"),
    );
    expect(parseUtcTimestampMs("2026-01-01 12:00:00.5")).toBe(
      Date.parse("2026-01-01T12:00:00.500Z"),
    );
  });

  it("prevents post-deadline failAudit mutations when remainingMs falls below floor during probe (V4-04)", async () => {
    let remaining = 2000;
    mocks.workflowGet.mockImplementation(async () => ({
      status: async () => {
        remaining = 100; // Budget exhausted during workflow status probe
        return { status: "terminated" };
      },
    }));

    const result = await reconcileRunningAudit(
      {
        id: "audit_late",
        workflowInstanceId: "wf_123",
        startedAt: "2026-01-01T00:00:00.000Z",
        currentPhase: "crawling",
      },
      5000,
      () => remaining,
      () => remaining > 0,
    );

    expect(result).toBeNull();
    expect(mocks.failAudit).not.toHaveBeenCalled();
  });

  it("reserves tick budget for canonical stale audits when irregular rows run slowly (V4-04)", async () => {
    vi.useFakeTimers();
    try {
      const irr = [
        {
          id: "irr_slow_0",
          workflowInstanceId: "wf_slow_0",
          startedAt: "2026-01-01T00:00:00.000Z",
          currentPhase: "crawling",
        },
        {
          id: "irr_slow_1",
          workflowInstanceId: "wf_slow_1",
          startedAt: "2026-01-01T00:00:00.000Z",
          currentPhase: "crawling",
        },
        {
          id: "irr_slow_2",
          workflowInstanceId: "wf_slow_2",
          startedAt: "2026-01-01T00:00:00.000Z",
          currentPhase: "crawling",
        },
        {
          id: "irr_slow_3",
          workflowInstanceId: "wf_slow_3",
          startedAt: "2026-01-01T00:00:00.000Z",
          currentPhase: "crawling",
        },
      ];
      mocks.findIrregularRunningAudits.mockResolvedValueOnce(irr);
      mocks.workflowGet.mockImplementation(async (wfId: string) => ({
        status: async () => {
          if (wfId.startsWith("wf_slow_")) {
            await vi.advanceTimersByTimeAsync(4_500);
          }
          return { status: "terminated" };
        },
      }));
      mocks.failAudit.mockResolvedValue(true);
      mocks.getStaleRunningAudits.mockResolvedValueOnce([
        {
          id: "canon_1",
          workflowInstanceId: "wf_canon_1",
          projectId: "proj_1",
          startedByUserId: "u1",
          startedAt: "2026-01-01T00:00:00.000Z",
          currentPhase: "crawling",
          pagesCrawled: 0,
          pagesTotal: 10,
        },
      ]);

      await reconcileStaleAudits();

      expect(mocks.getStaleRunningAudits).toHaveBeenCalled();
      expect(mocks.failAudit).toHaveBeenCalledWith(
        "canon_1",
        "wf_canon_1",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
