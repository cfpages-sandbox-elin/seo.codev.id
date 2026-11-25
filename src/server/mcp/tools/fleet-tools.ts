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

    // Sol Round 18 F2, Round 21 F13: Bind repository qualification strictly to effective approved roster version (skip for edge-only)
    let approvedRosterId: string | undefined;
    if (source !== "edge") {
      const approvedRoster = await FleetRepository.getApprovedRoster(orgId);
      approvedRosterId = approvedRoster?.id;
    }

    const repoAuditSubquery = (alias: string) => {
      if (!approvedRosterId) {
        return sql`(SELECT NULL WHERE 1 = 0)`;
      }
      const configPredicate = isPg
        ? `CASE WHEN (${alias}.config IS NOT NULL AND pg_input_is_valid(${alias}.config, 'jsonb')) THEN (${alias}.config::jsonb ->> 'source') = 'github_repository_direct' AND (${alias}.config::jsonb ->> 'repoName') = m.repo_name AND coalesce(${alias}.config::jsonb ->> 'publishRoot', '.') = coalesce(m.publish_root, '.') AND (${alias}.config::jsonb #>> '{rosterSource,versionId}') = m.version_id AND (${alias}.config::jsonb #>> '{rosterSource,memberId}') = m.id AND (${alias}.config::jsonb #>> '{rosterSource,projectId}') = m.project_id AND lower(trim(${alias}.config::jsonb #>> '{rosterSource,canonicalHost}')) = lower(trim(m.canonical_host)) AND (${alias}.config::jsonb #>> '{rosterSource,repoName}') = m.repo_name AND jsonb_typeof(${alias}.config::jsonb #> '{rosterSource,publishRoot}') = 'string' AND (${alias}.config::jsonb #>> '{rosterSource,publishRoot}') = coalesce(m.publish_root, '.') ELSE false END`
        : `CASE WHEN json_valid(${alias}.config) THEN json_extract(${alias}.config, '$.source') = 'github_repository_direct' AND json_extract(${alias}.config, '$.repoName') = m.repo_name AND coalesce(json_extract(${alias}.config, '$.publishRoot'), '.') = coalesce(m.publish_root, '.') AND json_extract(${alias}.config, '$.rosterSource.versionId') = m.version_id AND json_extract(${alias}.config, '$.rosterSource.memberId') = m.id AND json_extract(${alias}.config, '$.rosterSource.projectId') = m.project_id AND lower(trim(json_extract(${alias}.config, '$.rosterSource.canonicalHost'))) = lower(trim(m.canonical_host)) AND json_extract(${alias}.config, '$.rosterSource.repoName') = m.repo_name AND json_type(${alias}.config, '$.rosterSource.publishRoot') = 'text' AND json_extract(${alias}.config, '$.rosterSource.publishRoot') = coalesce(m.publish_root, '.') ELSE 0 END`;

      return sql`(SELECT ${sql.raw(alias)}.id FROM audits ${sql.raw(alias)} WHERE ${sql.raw(alias)}.project_id = ${projects.id} AND ${sql.raw(alias)}.status = 'completed' AND ${sql.raw(alias)}.workflow_instance_id LIKE 'github-audit-%' AND ${sql.raw(alias)}.pages_total > 0 AND ${sql.raw(alias)}.pages_crawled >= ${sql.raw(alias)}.pages_total AND EXISTS (SELECT 1 FROM fleet_roster_members m JOIN fleet_run_items fri ON fri.audit_id = ${sql.raw(alias)}.id AND fri.member_id = m.id AND fri.project_id = ${projects.id} AND fri.primary_series_key = 'diagnostic' AND fri.status = 'completed' JOIN fleet_runs fr ON fr.id = fri.run_id AND fr.roster_version_id = m.version_id AND fr.organization_id = ${projects.organizationId} AND fr.status = 'completed' JOIN fleet_snapshots fs ON fs.run_item_id = fri.id AND fs.member_id = m.id AND fs.project_id = ${projects.id} AND lower(trim(fs.canonical_host)) = lower(trim(m.canonical_host)) AND fs.series_key = 'diagnostic' WHERE m.project_id = ${projects.id} AND lower(trim(m.canonical_host)) = lower(trim(${projects.domain})) AND m.enrollment_state = 'active' AND m.version_id = ${approvedRosterId} AND fr.roster_version_id = ${approvedRosterId} AND m.repo_name IS NOT NULL AND ${sql.raw(configPredicate)}) ORDER BY ${completedTimeFor(alias)} DESC NULLS LAST, ${sql.raw(alias)}.id DESC LIMIT 1)`;
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
        throw new Error(
          `Invalid canonical hostname: "${args.domain}". Must be lowercase RFC 1123 hostname without protocol, port, or path.`,
        );
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

// Sol Round 21 F04: Implement and register get_fleet_matrix
export { getFleetMatrixTool } from "./get-fleet-matrix";
export { linkFleetRepositoryTool } from "./link-fleet-repository";
export { runFleetAuditTool } from "./run-fleet-audit";
