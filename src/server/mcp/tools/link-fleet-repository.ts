import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { fleetRosterMembers } from "@/db/schema";
import { FleetRepository } from "@/server/features/fleet/repositories/FleetRepository";
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
    .default(".")
    .describe("Optional repository-relative publish directory (default: '.')."),
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

    const domain = args.domain.toLowerCase().trim();
    if (!isValidCanonicalHostname(domain)) {
      throw new Error(
        `Invalid canonical hostname: "${domain}". Must be lowercase RFC 1123 hostname without protocol, port, or path.`,
      );
    }

    const cleanSlug = normalizeRepoSlug(args.repoName);
    const cleanRoot = normalizeGitRelativePath(args.publishRoot ?? ".");

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

    const currentSlug = member.repoName?.trim();
    const currentRoot = normalizeGitRelativePath(member.publishRoot);

    if (currentSlug === cleanSlug && currentRoot === cleanRoot) {
      return mcpResponse({
        structuredContent: {
          status: "unchanged",
          domain,
          repoName: cleanSlug,
          publishRoot: cleanRoot,
          memberId: member.id,
          versionId: approvedRoster.id,
        },
        text: `Repository mapping for '${domain}' is already linked to '${cleanSlug}' (root: '${cleanRoot}') in roster '${approvedRoster.id}'.`,
      });
    }

    await db
      .update(fleetRosterMembers)
      .set({
        repoName: cleanSlug,
        publishRoot: cleanRoot,
      })
      .where(eq(fleetRosterMembers.id, member.id));

    return mcpResponse({
      structuredContent: {
        status: "linked",
        domain,
        repoName: cleanSlug,
        publishRoot: cleanRoot,
        memberId: member.id,
        versionId: approvedRoster.id,
      },
      text: `Successfully linked '${domain}' to repository '${cleanSlug}' (root: '${cleanRoot}') in roster '${approvedRoster.id}'.`,
    });
  },
};
