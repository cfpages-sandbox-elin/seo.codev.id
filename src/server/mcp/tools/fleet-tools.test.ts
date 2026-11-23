import { describe, expect, it, vi } from "vitest";
import { getFleetIssuesTool, runFleetAuditTool } from "./fleet-tools";
import { makeToolContext } from "./tool-test-support";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const toolContext = makeToolContext();

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

      const data = result.structuredContent as any;
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

      const data = result.structuredContent as any;
      expect(data.status).toBe("configured");
      expect(data.mode).toBe("repository_direct");
      expect(data.executionCommand).toContain("run-github-fleet-audit.ts --domain kaca.co.id --max-pages 500");
    });

    it("generates execution command for edge workflow mode", async () => {
      const result = await runFleetAuditTool.handler(
        { mode: "edge_workflow", concurrency: 3 },
        toolContext,
      );

      const data = result.structuredContent as any;
      expect(data.status).toBe("configured");
      expect(data.mode).toBe("edge_workflow");
      expect(data.executionCommand).toContain("run-fleet-audits.ts --concurrency 3");
    });
  });
});
