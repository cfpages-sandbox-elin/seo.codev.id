import { describe, expect, it, vi } from "vitest";
import { reconcileRunningAudit, reconcileStaleAudits } from "./auditReconciler";

const mockGet = vi.fn();
const dbHoisted = vi.hoisted(() => ({
  cursorRow: null as {
    id: string;
    startedAt: string | null;
    auditId: string | null;
    revision: number;
  } | null,
  auditBatches: [] as Array<
    Array<{
      id: string;
      workflowInstanceId: string | null;
      projectId: string;
      startedByUserId: string;
      startedAt: string;
      currentPhase: string | null;
      pagesCrawled: number;
      pagesTotal: number;
    }>
  >,
  insertRevisions: [] as number[],
  updateRevisions: [] as number[],
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    SITE_AUDIT_WORKFLOW: {
      get: (...args: unknown[]): unknown => mockGet(...args),
    },
  },
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    failAudit: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db/provider", () => ({
  getDatabaseProvider: () => "d1",
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      watchdogCursor: {
        findFirst: async () => dbHoisted.cursorRow,
      },
      audits: {
        findMany: async () => dbHoisted.auditBatches.shift() ?? [],
      },
      projects: {
        findFirst: async () => ({
          id: "proj_1",
          organizationId: "shared-workspace",
        }),
      },
    },
    insert: () => ({
      values: (vals: {
        id: string;
        startedAt: string | null;
        auditId: string | null;
        revision: number;
      }) => {
        dbHoisted.insertRevisions.push(vals.revision);
        dbHoisted.cursorRow = {
          id: vals.id,
          startedAt: vals.startedAt,
          auditId: vals.auditId,
          revision: vals.revision,
        };
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ revision: vals.revision }],
          }),
        };
      },
    }),
    update: () => ({
      set: (vals: {
        startedAt: string | null;
        auditId: string | null;
        revision: number;
      }) => ({
        where: () => ({
          returning: async () => {
            dbHoisted.updateRevisions.push(vals.revision);
            if (dbHoisted.cursorRow) {
              dbHoisted.cursorRow = {
                ...dbHoisted.cursorRow,
                startedAt: vals.startedAt,
                auditId: vals.auditId,
                revision: vals.revision,
              };
            }
            return [{ revision: vals.revision }];
          },
        }),
      }),
    }),
  },
}));

type MockCursorRow = {
  id: string;
  startedAt: string | null;
  auditId: string | null;
  revision: number;
};

const readMockCursorRow = (): MockCursorRow | null => dbHoisted.cursorRow;

describe("auditReconciler", () => {
  it("immediately returns null and skips Cloudflare Workflows lookup for repository audits (Sol P1-05)", async () => {
    mockGet.mockClear();

    const repoAudit = {
      id: "audit_repo_1",
      workflowInstanceId: "github-audit-12345",
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      currentPhase: "analyzing",
    };

    const result = await reconcileRunningAudit(repoAudit);
    expect(result).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("attempts workflow reconciliation for edge audits", async () => {
    mockGet.mockClear();
    mockGet.mockRejectedValueOnce(new Error("Workflow instance not found"));

    const edgeAudit = {
      id: "audit_edge_1",
      workflowInstanceId: "site-audit-workflow-9999",
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      currentPhase: "crawling",
    };

    const result = await reconcileRunningAudit(edgeAudit);
    expect(mockGet).toHaveBeenCalledWith("site-audit-workflow-9999");
    expect(result).toEqual({
      errorCode: "instance_lost",
      errorDetail: "Workflow instance not found",
    });
  });

  it("returns null when failAudit returns false due to a lost race with workflow finalize", async () => {
    mockGet.mockClear();
    mockGet.mockRejectedValueOnce(new Error("Workflow instance not found"));
    const { AuditRepository } =
      await import("@/server/features/audit/repositories/AuditRepository");
    vi.mocked(AuditRepository.failAudit).mockResolvedValueOnce(false);

    const edgeAudit = {
      id: "audit_edge_2",
      workflowInstanceId: "site-audit-workflow-raced",
      startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      currentPhase: "crawling",
    };

    const result = await reconcileRunningAudit(edgeAudit);
    expect(result).toBeNull();
  });

  it("reclaims abandoned repository audits older than 2 hours winning failAudit race", async () => {
    mockGet.mockClear();
    const { AuditRepository } =
      await import("@/server/features/audit/repositories/AuditRepository");
    vi.mocked(AuditRepository.failAudit).mockResolvedValueOnce(true);

    const oldRepoAudit = {
      id: "audit_repo_timed_out",
      workflowInstanceId: "github-audit-9999",
      startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      currentPhase: "analyzing",
    };

    const result = await reconcileRunningAudit(oldRepoAudit);
    expect(result).toEqual({
      errorCode: "runner_timeout",
      errorDetail:
        "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
    });
    expect(mockGet).not.toHaveBeenCalled();
    expect(AuditRepository.failAudit).toHaveBeenCalledWith(
      "audit_repo_timed_out",
      "github-audit-9999",
      {
        errorCode: "runner_timeout",
        errorDetail:
          "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
        failedPhase: "analyzing",
      },
    );
  });

  it("returns null when repository audit older than 2 hours loses failAudit race", async () => {
    mockGet.mockClear();
    const { AuditRepository } =
      await import("@/server/features/audit/repositories/AuditRepository");
    vi.mocked(AuditRepository.failAudit).mockResolvedValueOnce(false);

    const oldRepoAudit = {
      id: "audit_repo_raced",
      workflowInstanceId: "github-audit-raced",
      startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      currentPhase: "analyzing",
    };

    const result = await reconcileRunningAudit(oldRepoAudit);
    expect(result).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("normalizes space-separated D1 timestamps as UTC correctly", async () => {
    mockGet.mockClear();
    const { AuditRepository } =
      await import("@/server/features/audit/repositories/AuditRepository");
    vi.mocked(AuditRepository.failAudit).mockResolvedValueOnce(true);

    // Format: "YYYY-MM-DD HH:MM:SS" (D1 SQLite default timestamp format)
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const d1TimestampRepoAudit = {
      id: "audit_repo_d1_ts",
      workflowInstanceId: "github-audit-d1-ts",
      startedAt: threeHoursAgo,
      currentPhase: "analyzing",
    };

    const result = await reconcileRunningAudit(d1TimestampRepoAudit);
    expect(result).toEqual({
      errorCode: "runner_timeout",
      errorDetail:
        "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
    });
  });

  it("treats unzoned ISO timestamps as invalid under strict UTC parsing (Sol V4-03)", async () => {
    mockGet.mockClear();
    const { AuditRepository } =
      await import("@/server/features/audit/repositories/AuditRepository");
    vi.mocked(AuditRepository.failAudit).mockResolvedValueOnce(true);

    const unzonedRepoAudit = {
      id: "audit_repo_unzoned",
      workflowInstanceId: "github-audit-unzoned",
      // Future unzoned ISO lacks Z or offset -> rejected by strict parseUtcTimestampMs -> isOlderThan returns true
      startedAt: "2099-01-01T00:00:00",
      currentPhase: "analyzing",
    };

    const result = await reconcileRunningAudit(unzonedRepoAudit);
    expect(result).toEqual({
      errorCode: "runner_timeout",
      errorDetail:
        "GitHub repository audit exceeded max run duration (2h) and was reclaimed.",
    });
  });

  it("bootstraps missing watchdog_cursor singleton at revision 1 and advances monotonically (Sol V4-01)", async () => {
    mockGet.mockClear();
    mockGet.mockRejectedValueOnce(new Error("Workflow instance not found"));
    dbHoisted.cursorRow = null;
    dbHoisted.insertRevisions.length = 0;
    dbHoisted.updateRevisions.length = 0;
    // Queue: [0] = irregular batch ([]), [1] = canonical stale batch (1 stale audit)
    dbHoisted.auditBatches = [
      [],
      [
        {
          id: "audit_stale_bootstrap",
          workflowInstanceId: "site-audit-workflow-stale-1",
          projectId: "proj_1",
          startedByUserId: "user_1",
          startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
          currentPhase: "crawling",
          pagesCrawled: 0,
          pagesTotal: 100,
        },
      ],
    ];

    await reconcileStaleAudits();

    expect(dbHoisted.insertRevisions).toEqual([1]);
    expect(dbHoisted.updateRevisions).toEqual([2]);
    const finalRow = readMockCursorRow();
    expect(finalRow?.revision).toBe(2);
    expect(finalRow?.startedAt).toBeNull();
    expect(finalRow?.auditId).toBeNull();
  });
});
