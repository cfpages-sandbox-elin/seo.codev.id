import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { fleetRosterMembers } from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { FleetRepository } from "@/server/features/fleet/repositories/FleetRepository";
import {
  pgUtcTimeSql,
  sqliteUtcTimeSql,
} from "@/server/features/fleet/services/fleetConstants";
import type { ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { normalizeGitRelativePath, normalizeRepoSlug } from "@/shared/git-repo";

const CANONICAL_DOMAIN_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isValidCanonicalHostname(domain: string): boolean {
  if (!domain || typeof domain !== "string" || domain.length > 253)
    return false;
  return CANONICAL_DOMAIN_REGEX.test(domain);
}

const linkFleetRepositoryInputSchema = {
  domain: z
    .string()
    .trim()
    .max(253)
    .regex(
      CANONICAL_DOMAIN_REGEX,
      "Must be a valid canonical hostname without protocol, path, or port",
    )
    .describe(
      "Canonical domain of the fleet member to link (e.g. 'kaca.co.id').",
    ),
  repoName: z
    .string()
    .trim()
    .min(3)
    .max(100)
    .describe(
      "GitHub repository slug in 'owner/repo' format (e.g. 'cfpages-site/toiletcubicle-co-id').",
    ),
  publishRoot: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional repository-relative publish directory (preserves current mapping if omitted).",
    ),
  expectedRosterId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional effective roster version ID to assert optimistic concurrency.",
    ),
} as const;

type LinkFleetRepositoryArgs = z.infer<
  z.ZodObject<typeof linkFleetRepositoryInputSchema>
>;

// Sol Round 21 F04: Implement and register link_fleet_repository
export const linkFleetRepositoryTool = {
  name: "link_fleet_repository",
  config: {
    title: "Link fleet repository",
    description:
      "Link or update the approved GitHub repository mapping and publish root for an enrolled fleet roster member in OpenSEO.",
    inputSchema: linkFleetRepositoryInputSchema,
    outputSchema: z
      .object({
        status: z.enum(["linked", "unchanged"]),
        domain: z.string(),
        repoName: z.string(),
        publishRoot: z.string(),
        memberId: z.string(),
        versionId: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  handler: async (args: LinkFleetRepositoryArgs, context: ToolContext) => {
    const orgId = context.auth?.organizationId;
    if (!orgId || orgId !== "shared-workspace") {
      throw new Error(
        `Fleet operations are currently constrained to the 'shared-workspace' organization; caller organization '${orgId ?? "unauthenticated"}' is not supported.`,
      );
    }

    // Sol Round 22 F03: Operator permission check (owner or admin only)
    const role = context.auth?.role;
    if (!role || (role !== "owner" && role !== "admin")) {
      throw new Error(
        `Unauthorized: linking fleet repositories requires 'owner' or 'admin' role in organization '${orgId}'; current role is '${role ?? "none"}'.`,
      );
    }

    const domain = args.domain.toLowerCase().trim();
    if (!isValidCanonicalHostname(domain)) {
      throw new Error(
        `Invalid canonical hostname: "${domain}". Must be lowercase RFC 1123 hostname without protocol, port, or path.`,
      );
    }

    const cleanSlug = normalizeRepoSlug(args.repoName);
    // Sol Round 22 F10: If publishRoot is omitted or undefined, preserve existing root rather than resetting to '.'
    const cleanRoot =
      args.publishRoot !== undefined
        ? normalizeGitRelativePath(args.publishRoot)
        : undefined;

    const approvedRoster = await FleetRepository.getApprovedRoster(orgId);
    if (!approvedRoster) {
      throw new Error(
        `No effective approved fleet roster found in organization '${orgId}'.`,
      );
    }

    if (args.expectedRosterId && approvedRoster.id !== args.expectedRosterId) {
      throw new Error(
        `Planned roster '${args.expectedRosterId}' is no longer effective on organization '${orgId}' (current effective: '${approvedRoster.id}').`,
      );
    }

    const members = await db
      .select({
        id: fleetRosterMembers.id,
        versionId: fleetRosterMembers.versionId,
        canonicalHost: fleetRosterMembers.canonicalHost,
        projectId: fleetRosterMembers.projectId,
        repoName: fleetRosterMembers.repoName,
        publishRoot: fleetRosterMembers.publishRoot,
        enrollmentState: fleetRosterMembers.enrollmentState,
      })
      .from(fleetRosterMembers)
      .where(
        and(
          eq(fleetRosterMembers.versionId, approvedRoster.id),
          eq(fleetRosterMembers.canonicalHost, domain),
        ),
      )
      .limit(1);

    if (members.length === 0) {
      throw new Error(
        `Domain '${domain}' is not enrolled in approved fleet roster '${approvedRoster.id}'.`,
      );
    }

    const member = members[0];
    if (member.enrollmentState !== "active") {
      throw new Error(
        `Domain '${domain}' is '${member.enrollmentState}' in roster '${approvedRoster.id}'; only active members can have repository bindings.`,
      );
    }

    const isPg = getDatabaseProvider() === "postgres";
    const pgTs = pgUtcTimeSql("approved_at");
    const sqliteTs = sqliteUtcTimeSql("approved_at");
    // Sol R24-02, R1: Shared strict UTC timestamp validation + binary collation tie-break
    const effectiveVersionSubquery = isPg
      ? sql.raw(`(
          SELECT id FROM fleet_roster_versions
          WHERE organization_id = ${"'" + orgId.replaceAll("'", "''") + "'"}
            AND approved_at IS NOT NULL
            AND ${pgTs} IS NOT NULL
            AND ${pgTs} <= CURRENT_TIMESTAMP
          ORDER BY ${pgTs} DESC NULLS LAST, id COLLATE "C" DESC
          LIMIT 1
        )`)
      : sql.raw(`(
          SELECT id FROM fleet_roster_versions
          WHERE organization_id = ${"'" + orgId.replaceAll("'", "''") + "'"}
            AND approved_at IS NOT NULL
            AND ${sqliteTs} IS NOT NULL
            AND ${sqliteTs} <= julianday('now')
          ORDER BY ${sqliteTs} DESC NULLS LAST, id COLLATE BINARY DESC
          LIMIT 1
        )`);

    const currentSlug = member.repoName?.trim();
    const currentRoot = normalizeGitRelativePath(member.publishRoot);
    const rootStillMatches =
      member.publishRoot === null
        ? isNull(fleetRosterMembers.publishRoot)
        : eq(fleetRosterMembers.publishRoot, member.publishRoot);

    if (
      currentSlug === cleanSlug &&
      (cleanRoot === undefined || currentRoot === cleanRoot)
    ) {
      // Sol Round 24 R24-11, V4-07: verify the mapping still matches exact raw root and effective member
      const verifyEffective = await db
        .select({
          id: fleetRosterMembers.id,
          publishRoot: fleetRosterMembers.publishRoot,
        })
        .from(fleetRosterMembers)
        .where(
          and(
            eq(fleetRosterMembers.id, member.id),
            eq(fleetRosterMembers.versionId, approvedRoster.id),
            eq(fleetRosterMembers.versionId, effectiveVersionSubquery),
            eq(fleetRosterMembers.enrollmentState, "active"),
            eq(fleetRosterMembers.repoName, cleanSlug),
            rootStillMatches,
          ),
        )
        .limit(1);

      if (verifyEffective.length > 0) {
        const liveRoot = normalizeGitRelativePath(
          verifyEffective[0].publishRoot,
        );
        return mcpResponse({
          structuredContent: {
            status: "unchanged",
            domain,
            repoName: cleanSlug,
            publishRoot: liveRoot,
            memberId: member.id,
            versionId: approvedRoster.id,
          },
          text: `Repository mapping for '${domain}' is already linked to '${cleanSlug}' (root: '${liveRoot}') in roster '${approvedRoster.id}'.`,
        });
      }
    }

    // Sol Round 24 P1-02: Omit publishRoot from update set when omitted from input
    const updateSet: { repoName: string; publishRoot?: string } = {
      repoName: cleanSlug,
    };
    if (cleanRoot !== undefined) {
      updateSet.publishRoot = cleanRoot;
    }

    // Sol Round 24 R24-11, V4-07: Atomic write-time assertion using raw old publishRoot value in CAS
    const updateRes = await db
      .update(fleetRosterMembers)
      .set(updateSet)
      .where(
        and(
          eq(fleetRosterMembers.id, member.id),
          eq(fleetRosterMembers.versionId, approvedRoster.id),
          eq(fleetRosterMembers.enrollmentState, "active"),
          eq(fleetRosterMembers.versionId, effectiveVersionSubquery),
          member.repoName === null
            ? isNull(fleetRosterMembers.repoName)
            : eq(fleetRosterMembers.repoName, member.repoName),
          rootStillMatches,
        ),
      )
      .returning({
        id: fleetRosterMembers.id,
        repoName: fleetRosterMembers.repoName,
        publishRoot: fleetRosterMembers.publishRoot,
      });

    if (!updateRes || updateRes.length === 0) {
      throw new Error(
        `Failed to link repository for '${domain}': member was modified or roster '${approvedRoster.id}' was superseded concurrently.`,
      );
    }

    const updated = updateRes[0];
    const finalPublishRoot = normalizeGitRelativePath(updated.publishRoot);

    return mcpResponse({
      structuredContent: {
        status: "linked",
        domain,
        repoName: cleanSlug,
        publishRoot: finalPublishRoot,
        memberId: updated.id,
        versionId: approvedRoster.id,
      },
      text: `Successfully linked '${domain}' to repository '${cleanSlug}' (root: '${finalPublishRoot}') in roster '${approvedRoster.id}'.`,
    });
  },
};
