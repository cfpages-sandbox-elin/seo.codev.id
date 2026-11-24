import { describe, expect, it, vi } from "vitest";
import { reconcileRunningAudit } from "./auditReconciler";

const mockGet = vi.fn();
vi.mock("cloudflare:workers", () => ({
  env: {
    SITE_AUDIT_WORKFLOW: {
      get: (...args: unknown[]): unknown => mockGet(...args),
    },
  },
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    failAudit: vi.fn(),
  },
}));

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
});
