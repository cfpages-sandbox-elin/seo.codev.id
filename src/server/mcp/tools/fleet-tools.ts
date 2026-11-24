import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { auditIssues, audits, projects } from "@/db/schema";
import { mcpResponse } from "@/server/mcp/formatters";
import type { ToolContext } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { routeIssueToSkill } from "@/server/lib/audit/issue-routing";
import { FleetRepository } from "@/server/features/fleet/repositories/FleetRepository";

const CANONICAL_DOMAIN_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isValidCanonicalHostname(domain: string): boolean {
  if (!domain || typeof domain !== "string" || domain.length > 253)
    return false;
  return CANONICAL_DOMAIN_REGEX.test(domain);
}

const fleetIssueItemShape = {
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
};

type EnrichedFleetIssue = z.infer<z.ZodObject<typeof fleetIssueItemShape>>;

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
        severityBreakdown: z
          .object({
            critical: z.number(),
            warning: z.number(),
            info: z.number(),
          })
          .passthrough(),
        skillRoutingBreakdown: z.record(z.string(), z.number()),
        issues: z.array(z.object(fleetIssueItemShape).passthrough()),
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
        ? sql.raw(`${alias}.completed_at::timestamptz`)
        : sql.raw(`julianday(${alias}.completed_at)`);

    // Sol Round 18 F2: Bind repository qualification strictly to effective approved roster version
    const approvedRoster = await FleetRepository.getApprovedRoster(orgId);
    const approvedRosterId = approvedRoster?.id;

    const repoAuditSubquery = (alias: string) => {
      if (!approvedRosterId) {
        return sql`(SELECT NULL WHERE 1 = 0)`;
      }
      return sql`(SELECT ${sql.raw(alias)}.id FROM audits ${sql.raw(alias)} WHERE ${sql.raw(alias)}.project_id = ${projects.id} AND ${sql.raw(alias)}.status = 'completed' AND ${sql.raw(alias)}.workflow_instance_id LIKE 'github-audit-%' AND EXISTS (SELECT 1 FROM fleet_roster_members m JOIN fleet_run_items fri ON fri.audit_id = ${sql.raw(alias)}.id AND fri.member_id = m.id AND fri.project_id = ${projects.id} AND fri.primary_series_key = 'diagnostic' AND fri.status = 'completed' JOIN fleet_runs fr ON fr.id = fri.run_id AND fr.roster_version_id = m.version_id AND fr.organization_id = ${projects.organizationId} AND fr.status = 'completed' JOIN fleet_snapshots fs ON fs.run_item_id = fri.id AND fs.member_id = m.id AND fs.project_id = ${projects.id} AND fs.canonical_host = m.canonical_host AND fs.series_key = 'diagnostic' WHERE m.project_id = ${projects.id} AND m.canonical_host = ${projects.domain} AND m.enrollment_state = 'active' AND m.version_id = ${approvedRosterId} AND fr.roster_version_id = ${approvedRosterId}) ORDER BY ${completedTimeFor(alias)} DESC NULLS LAST, ${sql.raw(alias)}.id DESC LIMIT 1)`;
    };

    let auditSelectorCondition;
    if (source === "edge") {
      auditSelectorCondition = eq(
        audits.id,
        sql`(SELECT a2.id FROM audits a2 WHERE a2.project_id = ${projects.id} AND a2.status = 'completed' AND (a2.workflow_instance_id NOT LIKE 'github-audit-%' OR a2.workflow_instance_id IS NULL) ORDER BY ${completedTimeFor("a2")} DESC NULLS LAST, a2.id DESC LIMIT 1)`,
      );
    } else if (source === "repository") {
      auditSelectorCondition = eq(audits.id, repoAuditSubquery("a2"));
    } else {
      auditSelectorCondition = sql`(${audits.id} = (SELECT a_edge.id FROM audits a_edge WHERE a_edge.project_id = ${projects.id} AND a_edge.status = 'completed' AND (a_edge.workflow_instance_id NOT LIKE 'github-audit-%' OR a_edge.workflow_instance_id IS NULL) ORDER BY ${completedTimeFor("a_edge")} DESC NULLS LAST, a_edge.id DESC LIMIT 1) OR ${audits.id} = ${repoAuditSubquery("a_repo")})`;
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
      { header: "Domain", value: (r) => r.domain },
      { header: "Source", value: (r) => r.source },
      { header: "Severity", value: (r) => r.severity },
      { header: "Issue Type", value: (r) => r.issueType },
      { header: "Page URL", value: (r) => r.pageUrl },
      { header: "Skill Route", value: (r) => r.skillRoute },
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

export { runFleetAuditTool } from "./run-fleet-audit";
