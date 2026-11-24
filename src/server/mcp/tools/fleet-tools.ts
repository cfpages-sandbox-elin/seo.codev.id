import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { auditIssues, audits, projects } from "@/db/schema";
import { mcpResponse } from "@/server/mcp/formatters";
import type { ToolContext } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { FLEET_MANIFEST_MEMBERS } from "@/server/features/fleet/data/fleetManifest";
import { routeIssueToSkill } from "@/server/lib/audit/issue-routing";

interface EnrichedFleetIssue {
  id: string;
  domain: string;
  auditId: string;
  source: string;
  issueType: string;
  severity: string;
  pageUrl: string;
  targetUrl: string | null;
  skillRoute: string;
  recommendedAction: string;
}

const CANONICAL_DOMAIN_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isValidCanonicalHostname(domain: string): boolean {
  if (!domain || typeof domain !== "string" || domain.length > 253)
    return false;
  return CANONICAL_DOMAIN_REGEX.test(domain);
}

const getFleetIssuesInputSchema = {
  domain: z
    .string()
    .trim()
    .max(253)
    .regex(
      CANONICAL_DOMAIN_REGEX,
      "Must be a valid canonical hostname without protocol, path, or port",
    )
    .optional()
    .describe("Optional domain to filter issues by (e.g. 'kaca.co.id')."),
  severity: z
    .enum(["critical", "warning", "info"])
    .optional()
    .describe(
      "Optional severity level to filter by ('critical', 'warning', 'info').",
    ),
  issueType: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional issue type filter (e.g. 'broken_link', 'missing-meta-description').",
    ),
  source: z
    .enum(["all", "edge", "repository", "both"])
    .optional()
    .describe(
      "Audit source lane filter: 'all' or 'both', 'edge', or 'repository'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Maximum number of issues to return (default 50, max 200)."),
} as const;

type GetFleetIssuesArgs = z.infer<
  z.ZodObject<typeof getFleetIssuesInputSchema>
>;

export const getFleetIssuesTool = {
  name: "get_fleet_issues",
  config: {
    title: "Get fleet issues",
    description:
      "Retrieve detected SEO issues across enrolled fleet properties in OpenSEO. Supports filtering by domain, severity, issue type, and audit source ('edge', 'repository', 'all', or 'both'). Automatically maps issues to remediation skills.",
    inputSchema: getFleetIssuesInputSchema,
    outputSchema: z
      .object({
        totalIssues: z.number(),
        severityBreakdown: z.object({
          critical: z.number(),
          warning: z.number(),
          info: z.number(),
        }),
        skillRoutingBreakdown: z.record(z.string(), z.number()),
        issues: z.array(
          z.object({
            id: z.string(),
            domain: z.string(),
            auditId: z.string(),
            source: z.string(),
            issueType: z.string(),
            severity: z.string(),
            pageUrl: z.string(),
            targetUrl: z.string().nullable(),
            skillRoute: z.string(),
            recommendedAction: z.string(),
          }),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async (args: GetFleetIssuesArgs, context: ToolContext) => {
    const orgId = context.auth?.organizationId;
    if (!orgId || orgId !== "shared-workspace") {
      throw new Error(
        `Fleet operations are currently constrained to the 'shared-workspace' organization; caller organization '${orgId ?? "unauthenticated"}' is not supported.`,
      );
    }

    const source = args.source ?? "all";
    const limit = args.limit ?? 50;
    const isPg = getDatabaseProvider() === "postgres";
    const completedTimeFor = (alias: string) =>
      isPg
        ? sql.raw(`${alias}.completed_at::timestamp AT TIME ZONE 'UTC'`)
        : sql.raw(`julianday(${alias}.completed_at)`);

    let auditSelectorCondition;
    if (source === "edge") {
      auditSelectorCondition = eq(
        audits.id,
        sql`(SELECT a2.id FROM audits a2 WHERE a2.project_id = ${projects.id} AND a2.status = 'completed' AND (a2.workflow_instance_id NOT LIKE 'github-audit-%' OR a2.workflow_instance_id IS NULL) ORDER BY ${completedTimeFor("a2")} DESC NULLS LAST, a2.id DESC LIMIT 1)`,
      );
    } else if (source === "repository") {
      auditSelectorCondition = eq(
        audits.id,
        sql`(SELECT a2.id FROM audits a2 WHERE a2.project_id = ${projects.id} AND a2.status = 'completed' AND a2.workflow_instance_id LIKE 'github-audit-%' ORDER BY ${completedTimeFor("a2")} DESC NULLS LAST, a2.id DESC LIMIT 1)`,
      );
    } else {
      auditSelectorCondition = sql`(${audits.id} = (SELECT a_edge.id FROM audits a_edge WHERE a_edge.project_id = ${projects.id} AND a_edge.status = 'completed' AND (a_edge.workflow_instance_id NOT LIKE 'github-audit-%' OR a_edge.workflow_instance_id IS NULL) ORDER BY ${completedTimeFor("a_edge")} DESC NULLS LAST, a_edge.id DESC LIMIT 1) OR ${audits.id} = (SELECT a_repo.id FROM audits a_repo WHERE a_repo.project_id = ${projects.id} AND a_repo.status = 'completed' AND a_repo.workflow_instance_id LIKE 'github-audit-%' ORDER BY ${completedTimeFor("a_repo")} DESC NULLS LAST, a_repo.id DESC LIMIT 1))`;
    }

    const conditions = [
      eq(projects.organizationId, orgId),
      isNull(projects.archivedAt),
      eq(audits.status, "completed"),
      auditSelectorCondition,
    ];

    if (args.domain) {
      if (!isValidCanonicalHostname(args.domain)) {
        return mcpResponse({
          text: `Error: Invalid canonical hostname: "${args.domain}". Must be lowercase RFC 1123 hostname without protocol, port, or path.`,
          structuredContent: { error: "invalid_domain", domain: args.domain },
        });
      }
      conditions.push(eq(projects.domain, args.domain.toLowerCase().trim()));
    }
    if (args.severity) conditions.push(eq(auditIssues.severity, args.severity));
    if (args.issueType) {
      const raw = args.issueType.trim();
      const hyphenated = raw.toLowerCase().replace(/_/g, "-");
      const underscored = raw.toLowerCase().replace(/-/g, "_");
      conditions.push(
        or(
          eq(auditIssues.issueType, raw),
          eq(auditIssues.issueType, hyphenated),
          eq(auditIssues.issueType, underscored),
        )!,
      );
    }

    const severityOrder = sql`CASE ${auditIssues.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;

    const rows = await db
      .select({
        id: auditIssues.id,
        auditId: audits.id,
        workflowInstanceId: audits.workflowInstanceId,
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
      .orderBy(severityOrder, projects.domain, desc(auditIssues.id))
      .limit(limit);

    const severityBreakdown = { critical: 0, warning: 0, info: 0 };
    const skillRoutingBreakdown: Record<string, number> = {};
    const detailSchema = z.object({ targetUrl: z.string().optional() });

    const enrichedIssues: EnrichedFleetIssue[] = rows.map((r) => {
      let parsedTargetUrl: string | null = null;
      if (r.detailsJson) {
        try {
          const parsed = detailSchema.safeParse(
            JSON.parse(r.detailsJson) as unknown,
          );
          if (parsed.success && parsed.data.targetUrl)
            parsedTargetUrl = parsed.data.targetUrl;
        } catch {}
      }
      if (r.severity in severityBreakdown) severityBreakdown[r.severity]++;
      const routing = routeIssueToSkill(
        r.issueType,
        parsedTargetUrl || r.pageUrl || "",
      );
      skillRoutingBreakdown[routing.skill] =
        (skillRoutingBreakdown[routing.skill] || 0) + 1;
      const issueSource =
        r.workflowInstanceId && r.workflowInstanceId.startsWith("github-audit-")
          ? "repository"
          : "edge";

      return {
        id: r.id,
        domain: r.domain || "",
        auditId: r.auditId,
        source: issueSource,
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
      { header: "Source", value: (row) => row.source },
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

const runFleetAuditInputSchema = {
  domain: z
    .string()
    .trim()
    .max(253, "Must be at most 253 characters")
    .regex(
      CANONICAL_DOMAIN_REGEX,
      "Must be a valid canonical hostname (e.g. 'toiletcubicle.co.id')",
    )
    .optional()
    .describe("Optional target domain to audit."),
  all: z
    .boolean()
    .optional()
    .describe("Explicitly plan audits for all enrolled fleet properties."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional limit for number of properties to plan."),
  mode: z
    .enum(["edge_workflow", "repository_direct"])
    .optional()
    .describe("Execution mode: 'repository_direct' or 'edge_workflow'."),
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
      "Plan and configure fleet-wide site audits across enrolled properties in OpenSEO. Read-only planning tool: outputs executable CLI argv and command without launching background processes.",
    inputSchema: runFleetAuditInputSchema,
    outputSchema: z
      .object({
        status: z.string(),
        planId: z.string(),
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
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async (args: RunFleetAuditArgs, context: ToolContext) => {
    const orgId = context.auth?.organizationId;
    if (!orgId || orgId !== "shared-workspace") {
      throw new Error(
        `Fleet runners are currently constrained to the 'shared-workspace' organization; caller organization '${orgId ?? "unauthenticated"}' is not supported.`,
      );
    }

    const domain = args.domain?.toLowerCase().trim();
    if (!domain && !args.all && !args.limit) {
      throw new Error(
        "An explicit scope is required: provide a target domain, specify --limit, or pass all=true.",
      );
    }

    const mode = args.mode ?? "repository_direct";
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
      if (proj.length === 0)
        throw new Error(
          `Domain '${domain}' is not enrolled in organization '${orgId}'.`,
        );

      if (mode === "repository_direct") {
        const manifestMember = FLEET_MANIFEST_MEMBERS.find(
          (m) => m.canonicalHost.toLowerCase() === domain,
        );
        if (!manifestMember?.repoName)
          throw new Error(
            `Domain '${domain}' does not have an approved repository mapping for repository_direct mode. Use edge_workflow mode or link a repository in the fleet manifest.`,
          );
      }
    }

    const planId = "plan_" + crypto.randomUUID();
    const scopeArgs: string[] = [];
    if (domain) {
      scopeArgs.push("--domain", domain);
    } else if (args.limit) {
      scopeArgs.push("--limit", String(args.limit));
    } else if (args.all) {
      scopeArgs.push("--all");
    }

    let argv: string[] = [];
    if (mode === "repository_direct") {
      argv = [
        "exec",
        "tsx",
        "scripts/run-github-fleet-audit.ts",
        ...scopeArgs,
        "--max-pages",
        String(maxPages),
      ];
    } else {
      argv = [
        "exec",
        "tsx",
        "scripts/run-fleet-audits.ts",
        ...scopeArgs,
        "--max-pages",
        String(maxPages),
        "--concurrency",
        String(concurrency),
      ];
    }

    const executionCommand = `pnpm ${argv.join(" ")}`;
    const message = domain
      ? `Fleet audit plan configured for ${domain} in ${mode} mode.`
      : `Fleet audit plan configured across enrolled properties in ${mode} mode.`;

    return mcpResponse({
      structuredContent: {
        status: "planned",
        planId,
        organizationId: orgId,
        mode,
        targetDomain: domain ?? null,
        message,
        executable: "pnpm",
        argv,
        executionCommand,
      },
      text: `${message}\nRead-only Execution Plan: \`${executionCommand}\`\nNote: To execute, run this command in a terminal or workflow.`,
    });
  },
};
