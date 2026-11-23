import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditIssues, audits, projects } from "@/db/schema";
import { mcpResponse } from "@/server/mcp/formatters";
import type { ToolContext } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";

function routeIssueToSkill(issueType: string, url: string = ""): {
  skill: string;
  action: string;
} {
  const t = (issueType || "").toLowerCase().replace(/-/g, "_");
  const u = (url || "").toLowerCase();

  if (
    t.includes("broken_image") ||
    u.includes(".css") ||
    u.includes(".js") ||
    u.includes("wp-content")
  ) {
    return {
      skill: "static-site-css-repair",
      action: "Repair missing theme assets, unstyled paths, or broken CSS/JS references in static export.",
    };
  }

  if (
    t.includes("orphan") ||
    t.includes("internal_link") ||
    t.includes("broken_link") ||
    t.includes("redirect_chain") ||
    t.includes("canonical")
  ) {
    return {
      skill: "internal-linking",
      action: "Establish incoming link mesh from hub pages to money pages and correct canonical references.",
    };
  }

  if (
    t.includes("title") ||
    t.includes("description") ||
    t.includes("heading") ||
    t.includes("thin_content") ||
    t.includes("duplicate")
  ) {
    return {
      skill: "unslop-seo",
      action: "Remove AI fluff, inject 40-word direct answers, and write unique meta title/descriptions.",
    };
  }

  if (
    t.includes("slow") ||
    t.includes("speed") ||
    t.includes("large_page") ||
    t.includes("lighthouse")
  ) {
    return {
      skill: "web-perf",
      action: "Audit Web Vitals, defer non-critical scripts, and optimize image payloads.",
    };
  }

  return {
    skill: "seo-audit",
    action: "General technical SEO remediation.",
  };
}

interface EnrichedFleetIssue {
  id: string;
  domain: string;
  issueType: string;
  severity: string;
  pageUrl: string;
  targetUrl: string | null;
  skillRoute: string;
  recommendedAction: string;
}

// ─── get_fleet_issues ────────────────────────────────────────────────────────

const getFleetIssuesInputSchema = {
  domain: z
    .string()
    .trim()
    .optional()
    .describe("Optional domain to filter issues by (e.g. 'kaca.co.id')."),
  severity: z
    .enum(["critical", "warning", "info"])
    .optional()
    .describe("Optional severity level to filter by ('critical', 'warning', 'info')."),
  issueType: z
    .string()
    .trim()
    .optional()
    .describe("Optional issue type filter (e.g. 'broken_link', 'missing_meta_description')."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Maximum number of issues to return (default 50, max 200)."),
} as const;

type GetFleetIssuesArgs = z.infer<z.ZodObject<typeof getFleetIssuesInputSchema>>;

export const getFleetIssuesTool = {
  name: "get_fleet_issues",
  config: {
    title: "Get fleet issues",
    description:
      "Query aggregated technical SEO issues across the entire enrolled fleet in OpenSEO. Returns grouped issues, severity breakdown, and sovereign skill routing tags (static-site-css-repair, internal-linking, unslop-seo, web-perf).",
    inputSchema: getFleetIssuesInputSchema,
    outputSchema: z
      .object({
        totalIssues: z.number(),
        severityBreakdown: z
          .object({
            critical: z.number(),
            warning: z.number(),
            info: z.number(),
          })
          .passthrough(),
        skillRoutingBreakdown: z.record(z.string(), z.number()),
        issues: z.array(
          z
            .object({
              id: z.string(),
              domain: z.string(),
              issueType: z.string(),
              severity: z.string(),
              pageUrl: z.string(),
              targetUrl: z.string().nullable(),
              skillRoute: z.string(),
              recommendedAction: z.string(),
            })
            .passthrough(),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  handler: async (args: GetFleetIssuesArgs, context: ToolContext) => {
    const limit = Math.max(1, Math.min(200, args.limit || 50));
    const conditions = [
      eq(projects.organizationId, context.auth.organizationId),
      isNull(projects.archivedAt),
      eq(audits.status, "completed"),
    ];

    if (args.domain) {
      conditions.push(eq(projects.domain, args.domain.toLowerCase().trim()));
    }
    if (args.severity) {
      conditions.push(eq(auditIssues.severity, args.severity));
    }
    if (args.issueType) {
      conditions.push(eq(auditIssues.issueType, args.issueType));
    }

    // Sol P1-7: Select authoritative auditIssues.pageUrl directly rather than auditPages.url,
    // ensuring site-level issues with null pageId are fully preserved with valid URLs.
    const rows = await db
      .select({
        id: auditIssues.id,
        issueType: auditIssues.issueType,
        severity: auditIssues.severity,
        detailsJson: auditIssues.detailsJson,
        pageUrl: auditIssues.pageUrl,
        domain: projects.domain,
      })
      .from(auditIssues)
      .innerJoin(audits, eq(audits.id, auditIssues.auditId))
      .innerJoin(projects, eq(projects.id, audits.projectId))
      .where(and(...conditions))
      .orderBy(desc(auditIssues.id))
      .limit(limit);

    const severityBreakdown = { critical: 0, warning: 0, info: 0 };
    const skillRoutingBreakdown: Record<string, number> = {};

    const detailSchema = z.object({ targetUrl: z.string().optional() });

    const enrichedIssues: EnrichedFleetIssue[] = rows.map((r) => {
      let parsedTargetUrl: string | null = null;
      if (r.detailsJson) {
        try {
          const parsed = detailSchema.safeParse(JSON.parse(r.detailsJson) as unknown);
          if (parsed.success && parsed.data.targetUrl) {
            parsedTargetUrl = parsed.data.targetUrl;
          }
        } catch {}
      }

      if (r.severity in severityBreakdown) {
        severityBreakdown[r.severity]++;
      }
      const routing = routeIssueToSkill(r.issueType, parsedTargetUrl || r.pageUrl || "");
      skillRoutingBreakdown[routing.skill] = (skillRoutingBreakdown[routing.skill] || 0) + 1;

      return {
        id: r.id,
        domain: r.domain || "",
        issueType: r.issueType,
        severity: r.severity,
        pageUrl: r.pageUrl || "",
        targetUrl: parsedTargetUrl,
        skillRoute: routing.skill,
        recommendedAction: routing.action,
      };
    });

    const columns: McpTableColumn<EnrichedFleetIssue>[] = [
      { header: "Domain", value: (row) => row.domain },
      { header: "Severity", value: (row) => row.severity },
      { header: "Issue Type", value: (row) => row.issueType },
      { header: "Page URL", value: (row) => row.pageUrl },
      { header: "Skill Route", value: (row) => row.skillRoute },
    ];

    const textTable = formatMcpTable(enrichedIssues, columns);
    const summaryText = `Fleet Issues Summary: ${enrichedIssues.length} issues (Critical: ${severityBreakdown.critical}, Warning: ${severityBreakdown.warning}, Info: ${severityBreakdown.info})\n\n${textTable}`;

    return mcpResponse({
      structuredContent: {
        totalIssues: enrichedIssues.length,
        severityBreakdown,
        skillRoutingBreakdown,
        issues: enrichedIssues,
      },
      text: summaryText,
    });
  },
};

// ─── run_fleet_audit ────────────────────────────────────────────────────────

const CANONICAL_DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const runFleetAuditInputSchema = {
  domain: z
    .string()
    .trim()
    .regex(CANONICAL_DOMAIN_REGEX, "Must be a valid canonical hostname (e.g. 'toiletcubicle.co.id')")
    .optional()
    .describe("Optional target domain to audit (e.g. 'toiletcubicle.co.id'). If omitted, runs fleet runner across eligible domains."),
  mode: z
    .enum(["edge_workflow", "repository_direct"])
    .optional()
    .describe("Execution mode: 'repository_direct' (fast static Git analysis) or 'edge_workflow' (Cloudflare Workflows crawler). Default 'repository_direct'."),
  maxPages: z
    .number()
    .int()
    .min(10)
    .max(10000)
    .optional()
    .describe("Maximum pages to crawl or inspect (default 2000)."),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Paced concurrency for workflow crawler batches (default 2)."),
} as const;

type RunFleetAuditArgs = z.infer<z.ZodObject<typeof runFleetAuditInputSchema>>;

export const runFleetAuditTool = {
  name: "run_fleet_audit",
  config: {
    title: "Run fleet audit",
    description:
      "Plan and configure fleet-wide site audits across enrolled properties in OpenSEO. Supports 'repository_direct' mode (fast static Git analysis via GitHub CLI) and 'edge_workflow' mode (Cloudflare Workflows live HTTP crawler).",
    inputSchema: runFleetAuditInputSchema,
    outputSchema: z
      .object({
        status: z.string(),
        runId: z.string(),
        organizationId: z.string(),
        mode: z.string(),
        targetDomain: z.string().nullable().optional(),
        message: z.string(),
        executable: z.string(),
        argv: z.array(z.string()),
        executionCommand: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  handler: async (args: RunFleetAuditArgs, context: ToolContext) => {
    const orgId = context.auth?.organizationId || "shared-workspace";
    const mode = args.mode ?? "repository_direct";
    const domain = args.domain?.toLowerCase().trim();
    const maxPages = args.maxPages || 2000;
    const concurrency = args.concurrency || 2;

    if (domain) {
      const proj = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, orgId),
            eq(projects.domain, domain),
            isNull(projects.archivedAt),
          ),
        )
        .limit(1);
      if (proj.length === 0) {
        throw new Error(`Domain '${domain}' is not enrolled in organization '${orgId}'.`);
      }
    }

    const runId = "plan_" + crypto.randomUUID();
    let argv: string[] = [];
    if (mode === "repository_direct") {
      argv = [
        "exec",
        "tsx",
        "scripts/run-github-fleet-audit.ts",
        ...(domain ? ["--domain", domain] : ["--all"]),
        "--max-pages",
        String(maxPages),
      ];
    } else {
      argv = [
        "exec",
        "tsx",
        "scripts/run-fleet-audits.ts",
        ...(domain ? ["--domain", domain] : ["--all"]),
        "--max-pages",
        String(maxPages),
        "--concurrency",
        String(concurrency),
      ];
    }

    const executionCommand = `pnpm ${argv.join(" ")}`;
    const message = domain
      ? `Fleet audit plan configured for ${domain} in ${mode} mode.`
      : `Fleet-wide audit plan configured across enrolled properties in ${mode} mode.`;

    return mcpResponse({
      structuredContent: {
        status: "configured",
        runId,
        organizationId: orgId,
        mode,
        targetDomain: domain ?? null,
        message,
        executable: "pnpm",
        argv,
        executionCommand,
      },
      text: `${message}\nExecution Plan: \`${executionCommand}\``,
    });
  },
};
