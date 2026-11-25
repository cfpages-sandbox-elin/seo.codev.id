import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { projects, fleetRosterMembers } from "@/db/schema";
import { mcpResponse } from "@/server/mcp/formatters";
import type { ToolContext } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { FleetRepository } from "@/server/features/fleet/repositories/FleetRepository";
import { isValidRepoSlug, normalizeGitRelativePath } from "@/shared/git-repo";

const CANONICAL_DOMAIN_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

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

function parseAndValidateScope(args: RunFleetAuditArgs): string | undefined {
  const domain = args.domain?.toLowerCase().trim();
  const selectorCount =
    Number(domain !== undefined && domain !== "") +
    Number(args.limit !== undefined) +
    Number(args.all === true);
  if (selectorCount === 0) {
    throw new Error(
      "An explicit scope is required: provide a target domain, specify --limit, or pass all=true.",
    );
  }
  if (selectorCount > 1) {
    throw new Error(
      "Use exactly one selector: choose either target domain, limit, or all=true.",
    );
  }
  return domain || undefined;
}

async function resolveTargetProject(
  orgId: string,
  domain: string,
): Promise<string> {
  const activeProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, orgId),
        eq(projects.domain, domain),
        isNull(projects.archivedAt),
      ),
    )
    .limit(2);
  if (activeProjects.length === 0) {
    throw new Error(
      `Domain '${domain}' is not enrolled in organization '${orgId}'.`,
    );
  }
  if (activeProjects.length > 1) {
    throw new Error(
      `Ambiguous domain binding: multiple active projects (${activeProjects.length}) found for '${domain}' in organization '${orgId}'.`,
    );
  }
  return activeProjects[0].id;
}

type BoundRosterMember = {
  id: string;
  enrollmentState: string;
  projectId: string | null;
  repoName: string | null;
  publishRoot: string | null;
};

async function resolveAndValidateRosterMember(
  effectiveRosterId: string,
  domain: string,
  targetProjectId: string,
  mode: string,
): Promise<BoundRosterMember> {
  const rosterMember = await db
    .select({
      id: fleetRosterMembers.id,
      enrollmentState: fleetRosterMembers.enrollmentState,
      projectId: fleetRosterMembers.projectId,
      repoName: fleetRosterMembers.repoName,
      publishRoot: fleetRosterMembers.publishRoot,
    })
    .from(fleetRosterMembers)
    .where(
      and(
        eq(fleetRosterMembers.versionId, effectiveRosterId),
        eq(fleetRosterMembers.canonicalHost, domain),
      ),
    )
    .limit(1);

  if (rosterMember.length === 0) {
    throw new Error(
      `Domain '${domain}' is not in approved fleet roster '${effectiveRosterId}'.`,
    );
  }
  const bound = rosterMember[0];
  if (bound.enrollmentState !== "active") {
    throw new Error(
      `Domain '${domain}' is '${bound.enrollmentState}' in roster '${effectiveRosterId}'; only active members can be planned for audit.`,
    );
  }
  if (!bound.projectId || bound.projectId !== targetProjectId) {
    throw new Error(
      `Domain '${domain}' has mismatched or missing project mapping in roster '${effectiveRosterId}'.`,
    );
  }
  if (mode === "repository_direct") {
    const repoName = bound.repoName?.trim();
    if (!repoName) {
      throw new Error(
        `Domain '${domain}' has no approved repository mapping in roster '${effectiveRosterId}' for repository_direct mode. Use edge_workflow mode or link an approved repository in the roster.`,
      );
    }
    if (!isValidRepoSlug(repoName)) {
      throw new Error(
        `Domain '${domain}' has an invalid repository slug '${bound.repoName}' in roster '${effectiveRosterId}'. Must be 'owner/repo'.`,
      );
    }
    try {
      normalizeGitRelativePath(bound.publishRoot);
    } catch (rootErr: unknown) {
      throw new Error(
        `Domain '${domain}' has an invalid publish root '${bound.publishRoot}' in roster '${effectiveRosterId}': ${rootErr instanceof Error ? rootErr.message : String(rootErr)}`,
        { cause: rootErr },
      );
    }
  }
  return bound;
}

function buildExecutionArgv(options: {
  mode: string;
  scopeArgs: string[];
  effectiveRosterId: string;
  maxPages: number;
  concurrency: number;
  domain?: string;
  boundRosterMember?: BoundRosterMember;
  targetProjectId?: string;
}): string[] {
  const {
    mode,
    scopeArgs,
    effectiveRosterId,
    maxPages,
    concurrency,
    domain,
    boundRosterMember,
    targetProjectId,
  } = options;

  if (mode === "repository_direct") {
    const argv = [
      "exec",
      "tsx",
      "scripts/run-github-fleet-audit.ts",
      ...scopeArgs,
      "--roster-id",
      effectiveRosterId,
      "--remote",
      "--max-pages",
      String(maxPages),
    ];
    if (domain && boundRosterMember) {
      if (boundRosterMember.repoName) {
        argv.push("--expected-repo", boundRosterMember.repoName.trim());
      }
      argv.push(
        "--expected-root",
        normalizeGitRelativePath(boundRosterMember.publishRoot),
      );
    }
    return argv;
  }

  const argv = [
    "exec",
    "tsx",
    "scripts/run-fleet-audits.ts",
    ...scopeArgs,
    "--roster-id",
    effectiveRosterId,
    "--remote",
    "--max-pages",
    String(maxPages),
    "--concurrency",
    String(concurrency),
  ];
  if (domain && targetProjectId) {
    argv.push("--expected-project", targetProjectId);
  }
  return argv;
}

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

    const domain = parseAndValidateScope(args);
    const mode = args.mode ?? "repository_direct";
    const maxPages = args.maxPages || 2000;
    const concurrency = args.concurrency || 2;

    const targetProjectId = domain
      ? await resolveTargetProject(orgId, domain)
      : undefined;

    const effectiveRoster = await FleetRepository.getApprovedRoster(orgId);
    if (!effectiveRoster) {
      throw new Error(
        `No effective approved fleet roster found in organization '${orgId}'. An approved roster version with approvedAt <= now is required.`,
      );
    }

    const boundRosterMember =
      domain && targetProjectId
        ? await resolveAndValidateRosterMember(
            effectiveRoster.id,
            domain,
            targetProjectId,
            mode,
          )
        : undefined;

    const planId = "plan_" + crypto.randomUUID();
    const scopeArgs: string[] = [];
    if (domain) {
      scopeArgs.push("--domain", domain);
    } else if (args.limit) {
      scopeArgs.push("--limit", String(args.limit));
    } else if (args.all) {
      scopeArgs.push("--all");
    }

    const argv = buildExecutionArgv({
      mode,
      scopeArgs,
      effectiveRosterId: effectiveRoster.id,
      maxPages,
      concurrency,
      domain,
      boundRosterMember,
      targetProjectId,
    });

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
        selection: domain ? "bound" : "deferred",
        targetDomain: domain ?? null,
        binding:
          domain && boundRosterMember
            ? {
                rosterId: effectiveRoster.id,
                memberId: boundRosterMember.id,
                projectId: targetProjectId ?? null,
                domain,
                repoName: boundRosterMember.repoName?.trim() ?? null,
                publishRoot: normalizeGitRelativePath(
                  boundRosterMember.publishRoot,
                ),
              }
            : null,
        message,
        executable: "pnpm",
        argv,
        executionCommand,
      },
      text: `${message}\nRead-only Execution Plan: \`${executionCommand}\`\nNote: To execute, run this command in a terminal or workflow.`,
    });
  },
};
