import { describe, expect, it, vi } from "vitest";
import { getFleetIssuesTool, runFleetAuditTool } from "./fleet-tools";
import { makeToolContext } from "./tool-test-support";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const toolContext = makeToolContext({ organizationId: "shared-workspace" });

vi.mock("@/db", () => {
  const dummyChain = {
    innerJoin: () => dummyChain,
    leftJoin: () => dummyChain,
    where: () => dummyChain,
    orderBy: () => dummyChain,
    limit: () => [
      {
        id: "issue_1",
        issueType: "broken_link",
        severity: "critical",
        detailsJson: JSON.stringify({ targetUrl: "/missing-style.css" }),
        pageUrl: "https://kaca.co.id/page1",
        domain: "kaca.co.id",
      },
      {
        id: "issue_2",
        issueType: "missing_meta_description",
        severity: "warning",
        detailsJson: null,
        pageUrl: "https://kaca.co.id/page2",
        domain: "kaca.co.id",
      },
    ],
  };

  return {
    db: {
      select: () => ({
        from: () => dummyChain,
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

      const data = getFleetIssuesTool.config.outputSchema.parse(result.structuredContent);
      expect(data).toBeDefined();
      expect(data.totalIssues).toBe(2);
      expect(data.severityBreakdown.critical).toBe(1);
      expect(data.severityBreakdown.warning).toBe(1);
      expect(data.issues).toHaveLength(2);
      expect(data.issues[0].skillRoute).toBe("static-site-css-repair");
      expect(data.issues[1].skillRoute).toBe("unslop-seo");
    });
  });

  describe("run_fleet_audit", () => {
    it("generates execution command for repository direct mode", async () => {
      const result = await runFleetAuditTool.handler(
        { mode: "repository_direct", domain: "kaca.co.id", maxPages: 500 },
        toolContext,
      );

      const data = runFleetAuditTool.config.outputSchema.parse(result.structuredContent);
      expect(data.status).toBe("configured");
      expect(data.mode).toBe("repository_direct");
      expect(data.executable).toBe("pnpm");
      expect(data.argv).toEqual([
        "exec",
        "tsx",
        "scripts/run-github-fleet-audit.ts",
        "--domain",
        "kaca.co.id",
        "--max-pages",
        "500",
      ]);
      expect(data.executionCommand).toContain("run-github-fleet-audit.ts --domain kaca.co.id --max-pages 500");
    });

    it("generates execution command for edge workflow mode", async () => {
      const result = await runFleetAuditTool.handler(
        { mode: "edge_workflow", concurrency: 3 },
        toolContext,
      );

      const data = runFleetAuditTool.config.outputSchema.parse(result.structuredContent);
      expect(data.status).toBe("configured");
      expect(data.mode).toBe("edge_workflow");
      expect(data.executionCommand).toContain("run-fleet-audits.ts");
      expect(data.executionCommand).toContain("--all");
      expect(data.executionCommand).toContain("--concurrency 3");
      expect(data.argv).toContain("--all");
      expect(data.argv).toContain("--concurrency");
      expect(data.argv).toContain("3");
    });

    it("rejects caller outside shared-workspace organization (Sol F6)", async () => {
      const foreignContext = makeToolContext({ organizationId: "foreign_org" });
      await expect(
        runFleetAuditTool.handler({ mode: "repository_direct" }, foreignContext),
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
      expect(schema.domain.safeParse("a".repeat(255) + ".com").success).toBe(false);
    });
  });
});
