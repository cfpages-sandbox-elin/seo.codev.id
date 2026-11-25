import { describe, expect, it, vi } from "vitest";
import {
  getFleetIssuesTool,
  getFleetMatrixTool,
  linkFleetRepositoryTool,
  runFleetAuditTool,
} from "./fleet-tools";
import { makeToolContext } from "./tool-test-support";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const toolContext = makeToolContext({ organizationId: "shared-workspace" });

vi.mock("@/db", () => {
  const dummyChain: Record<string, unknown> = {
    innerJoin: () => dummyChain,
    leftJoin: () => dummyChain,
    where: () => dummyChain,
    orderBy: () => dummyChain,
    // oxlint-disable-next-line eslint-plugin-unicorn/no-thenable
    then: (resolve: (val: unknown) => void) => {
      resolve([
        {
          id: "roster_v1",
          approvedAt: "2026-11-20T00:00:00Z",
          domainCount: 1,
        },
      ]);
    },
    limit: (count?: number) => {
      if (count === 1) {
        return [
          {
            id: "member_1",
            enrollmentState: "active",
            projectId: "proj_1",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
            publishRoot: ".",
            versionId: "roster_v1",
          },
        ];
      }
      if (count === 2) {
        return [{ id: "proj_1", domain: "kaca.co.id" }];
      }
      if (count === 100) {
        return [
          {
            id: "roster_v1",
            approvedAt: "2026-11-20T00:00:00Z",
            domainCount: 1,
          },
        ];
      }
      return [
        {
          id: "issue_1",
          auditId: "audit_1",
          workflowInstanceId: null,
          issueType: "broken_link",
          severity: "critical",
          detailsJson: JSON.stringify({ targetUrl: "/missing-style.css" }),
          pageUrl: "https://kaca.co.id/page1",
          domain: "kaca.co.id",
        },
        {
          id: "issue_2",
          auditId: "audit_2",
          workflowInstanceId: "github-audit-123",
          issueType: "missing_meta_description",
          severity: "warning",
          detailsJson: null,
          pageUrl: "https://kaca.co.id/page2",
          domain: "kaca.co.id",
        },
      ];
    },
  };

  return {
    db: {
      select: () => ({
        from: () => dummyChain,
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: () => [
              {
                id: "member_1",
                repoName: vals.repoName ?? "cfpages-syamsulalam-net/kaca-co-id",
                publishRoot: vals.publishRoot ?? "dist",
                versionId: "roster_v1",
              },
            ],
          }),
        }),
      }),
    },
  };
});

describe("Fleet MCP Tools", () => {
  describe("get_fleet_issues", () => {
    it("returns aggregated fleet issues with breakdown and skill routing", async () => {
      const result = await getFleetIssuesTool.handler(
        { limit: 10 },
        toolContext,
      );

      const data = getFleetIssuesTool.config.outputSchema.parse(
        result.structuredContent,
      );
      expect(data).toBeDefined();
      expect(data.totalIssues).toBe(2);
      expect(data.severityBreakdown.critical).toBe(1);
      expect(data.severityBreakdown.warning).toBe(1);
      expect(data.issues).toHaveLength(2);
      expect(data.issues[0].skillRoute).toBe("static-site-css-repair");
      expect(data.issues[0].source).toBe("edge");
      expect(data.issues[0].auditId).toBe("audit_1");
      expect(data.issues[1].skillRoute).toBe("unslop-seo");
      expect(data.issues[1].source).toBe("repository");
      expect(data.issues[1].auditId).toBe("audit_2");
    });

    it.each(["all", "both", "edge", "repository"] as const)(
      "executes get_fleet_issues handler with source filter '%s' without SQL or projection error",
      async (source) => {
        const result = await getFleetIssuesTool.handler(
          { limit: 10, source },
          toolContext,
        );
        expect(result.structuredContent).toBeDefined();
        const data = getFleetIssuesTool.config.outputSchema.parse(
          result.structuredContent,
        );
        expect(data.totalIssues).toBe(2);
      },
    );

    it("validates canonical domain input in get_fleet_issues schema (Sol P2-08)", () => {
      const schema = getFleetIssuesTool.config.inputSchema;
      expect(schema.domain.safeParse("a.id").success).toBe(true);
      expect(schema.domain.safeParse("kaca.co.id").success).toBe(true);
      expect(schema.domain.safeParse("-invalid.com").success).toBe(false);
      expect(schema.domain.safeParse("https://kaca.co.id").success).toBe(false);
      expect(schema.domain.safeParse("kaca.co.id/path").success).toBe(false);
    });

    it("rejects invalid canonical domain in handler (Sol P2-08)", async () => {
      await expect(
        getFleetIssuesTool.handler(
          { limit: 10, domain: "-invalid.com" },
          toolContext,
        ),
      ).rejects.toThrow(/Invalid canonical hostname/);
    });

    it("rejects caller outside shared-workspace organization (Sol P2-06)", async () => {
      const foreignContext = makeToolContext({ organizationId: "foreign_org" });
      await expect(
        getFleetIssuesTool.handler({ limit: 10 }, foreignContext),
      ).rejects.toThrow(/shared-workspace/);
    });
  });

  describe("run_fleet_audit", () => {
    it("generates execution command for repository direct mode", async () => {
      const result = await runFleetAuditTool.handler(
        { mode: "repository_direct", domain: "kaca.co.id", maxPages: 500 },
        toolContext,
      );

      const data = runFleetAuditTool.config.outputSchema.parse(
        result.structuredContent,
      );
      expect(data.status).toBe("planned");
      expect(data.planId).toBeDefined();
      expect(data.planId).toMatch(/^plan_/);
      expect(data.mode).toBe("repository_direct");
      expect(data.executable).toBe("pnpm");
      expect(data.argv).toEqual([
        "exec",
        "tsx",
        "scripts/run-github-fleet-audit.ts",
        "--domain",
        "kaca.co.id",
        "--roster-id",
        "roster_v1",
        "--remote",
        "--max-pages",
        "500",
      ]);
      expect(data.executionCommand).toContain(
        "run-github-fleet-audit.ts --domain kaca.co.id --roster-id roster_v1 --remote --max-pages 500",
      );
    });

    it("generates execution command for edge workflow mode", async () => {
      const result = await runFleetAuditTool.handler(
        { mode: "edge_workflow", all: true, concurrency: 3 },
        toolContext,
      );

      const data = runFleetAuditTool.config.outputSchema.parse(
        result.structuredContent,
      );
      expect(data.status).toBe("planned");
      expect(data.planId).toBeDefined();
      expect(data.mode).toBe("edge_workflow");
      expect(data.executionCommand).toContain("run-fleet-audits.ts");
      expect(data.executionCommand).toContain("--all");
      expect(data.executionCommand).toContain("--concurrency 3");
      expect(data.argv).toContain("--all");
      expect(data.argv).toContain("--concurrency");
      expect(data.argv).toContain("3");
    });

    it("rejects run_fleet_audit when no scope is provided (no domain, limit, or all)", async () => {
      await expect(
        runFleetAuditTool.handler({ mode: "edge_workflow" }, toolContext),
      ).rejects.toThrow(/An explicit scope is required/);
    });

    it("rejects caller outside shared-workspace organization (Sol F6)", async () => {
      const foreignContext = makeToolContext({ organizationId: "foreign_org" });
      await expect(
        runFleetAuditTool.handler(
          { mode: "repository_direct" },
          foreignContext,
        ),
      ).rejects.toThrow(/shared-workspace/);
    });

    it("rejects unauthenticated caller without organizationId (Sol F6)", async () => {
      const anonContext = makeToolContext({ organizationId: undefined });
      await expect(
        runFleetAuditTool.handler({ mode: "repository_direct" }, anonContext),
      ).rejects.toThrow(/shared-workspace/);
    });

    it("validates canonical hostnames including single-letter labels like a.id (Sol F6)", () => {
      const schema = runFleetAuditTool.config.inputSchema;
      expect(schema.domain.safeParse("a.id").success).toBe(true);
      expect(schema.domain.safeParse("toiletcubicle.co.id").success).toBe(true);
      expect(schema.domain.safeParse("-invalid.com").success).toBe(false);
      expect(schema.domain.safeParse("invalid-.com").success).toBe(false);
      expect(schema.domain.safeParse("a".repeat(255) + ".com").success).toBe(
        false,
      );
    });
  });

  describe("link_fleet_repository", () => {
    it("validates canonical domain input in link_fleet_repository schema", () => {
      const schema = linkFleetRepositoryTool.config.inputSchema;
      expect(schema.domain.safeParse("a.id").success).toBe(true);
      expect(schema.domain.safeParse("kaca.co.id").success).toBe(true);
      expect(schema.domain.safeParse("-invalid.com").success).toBe(false);
      expect(schema.domain.safeParse("https://kaca.co.id").success).toBe(false);
    });

    it("rejects non-operator caller with member role (Sol Round 22 F03)", async () => {
      const memberContext = makeToolContext({
        organizationId: "shared-workspace",
        role: "member",
      });
      await expect(
        linkFleetRepositoryTool.handler(
          {
            domain: "kaca.co.id",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
          },
          memberContext,
        ),
      ).rejects.toThrow(
        /linking fleet repositories requires 'owner' or 'admin' role/,
      );
    });

    it("rejects caller outside shared-workspace organization", async () => {
      const foreignContext = makeToolContext({
        organizationId: "foreign_org",
        role: "owner",
      });
      await expect(
        linkFleetRepositoryTool.handler(
          {
            domain: "kaca.co.id",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
          },
          foreignContext,
        ),
      ).rejects.toThrow(/shared-workspace/);
    });

    it("rejects invalid canonical domain in handler", async () => {
      await expect(
        linkFleetRepositoryTool.handler(
          {
            domain: "-invalid.com",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
          },
          toolContext,
        ),
      ).rejects.toThrow(/Invalid canonical hostname/);
    });

    it("successfully links repository mapping in effective roster (Sol Round 24 P1-02)", async () => {
      const res = await linkFleetRepositoryTool.handler(
        {
          domain: "kaca.co.id",
          repoName: "cfpages-syamsulalam-net/kaca-co-id",
          publishRoot: "dist",
        },
        toolContext,
      );
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent.status).toBe("linked");
      expect(res.structuredContent.publishRoot).toBe("dist");
    });

    it("returns unchanged when mapping matches active member in effective roster (Sol Round 24 P1-02)", async () => {
      const res = await linkFleetRepositoryTool.handler(
        {
          domain: "kaca.co.id",
          repoName: "cfpages-syamsulalam-net/kaca-co-id",
        },
        toolContext,
      );
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent.status).toBe("unchanged");
      expect(res.structuredContent.publishRoot).toBe(".");
    });
  });

  describe("get_fleet_matrix", () => {
    it("validates canonical domain input in get_fleet_matrix schema", () => {
      const schema = getFleetMatrixTool.config.inputSchema;
      expect(schema.domain.safeParse("a.id").success).toBe(true);
      expect(schema.domain.safeParse("kaca.co.id").success).toBe(true);
      expect(schema.domain.safeParse("-invalid.com").success).toBe(false);
    });

    it("rejects caller outside shared-workspace organization", async () => {
      const foreignContext = makeToolContext({ organizationId: "foreign_org" });
      await expect(
        getFleetMatrixTool.handler({}, foreignContext),
      ).rejects.toThrow(/shared-workspace/);
    });
  });
});
