import { z } from "zod";
import type { ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import {
  FleetService,
  type FleetDomainSummary,
} from "@/server/features/fleet/services/FleetService";
import { isValidCanonicalHostname } from "@/server/features/fleet/services/fleetConstants";

const getFleetMatrixInputSchema = {
  domain: z
    .string()
    .trim()
    .max(253)
    .refine(
      isValidCanonicalHostname,
      "Must be a valid canonical hostname without protocol, path, or port",
    )
    .optional()
    .describe(
      "Optional single domain to filter the fleet matrix (e.g. 'kaca.co.id'). Omit for all 87 members.",
    ),
} as const;

type GetFleetMatrixArgs = z.infer<
  z.ZodObject<typeof getFleetMatrixInputSchema>
>;

// Sol Round 21 F04: Implement and register get_fleet_matrix
export const getFleetMatrixTool = {
  name: "get_fleet_matrix",
  config: {
    title: "Get fleet matrix",
    description:
      "Retrieve the complete 87-domain OpenSEO fleet overview matrix, including per-pillar health scores, grades, dispositions, and comparison metrics across all enrolled properties.",
    inputSchema: getFleetMatrixInputSchema,
    outputSchema: z
      .object({
        rosterVersion: z.string(),
        totalDomains: z.number(),
        filteredCount: z.number().optional(),
        gradedCount: z.number(),
        medianScore: z.number().nullable(),
        criticalIncidentsCount: z.number(),
        gradeDistribution: z.record(z.string(), z.number()),
        domains: z.array(z.record(z.string(), z.unknown())),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: async (args: GetFleetMatrixArgs, context: ToolContext) => {
    const orgId = context.auth?.organizationId;
    if (!orgId || orgId !== "shared-workspace") {
      throw new Error(
        `Fleet operations are currently constrained to the 'shared-workspace' organization; caller organization '${orgId ?? "unauthenticated"}' is not supported.`,
      );
    }
    const overview = await FleetService.getOverview(orgId);
    let domains: FleetDomainSummary[] = overview.domains;
    const fleetTotalDomains = overview.totalDomains;
    if (args.domain) {
      const target = args.domain.toLowerCase().trim();
      domains = domains.filter(
        (row: FleetDomainSummary) => row.canonicalHost.toLowerCase() === target,
      );
    }
    return mcpResponse({
      structuredContent: {
        rosterVersion: overview.rosterVersion,
        totalDomains: fleetTotalDomains,
        filteredCount: domains.length,
        gradedCount: overview.gradedCount,
        medianScore: overview.medianScore,
        criticalIncidentsCount: overview.criticalIncidentsCount,
        gradeDistribution: overview.gradeDistribution,
        domains,
      },
      text: args.domain
        ? `Retrieved fleet matrix row for domain '${args.domain}' (${domains.length} match found, fleet total: ${fleetTotalDomains}).`
        : `Retrieved fleet matrix with ${domains.length} domain entries for organization '${orgId}'.`,
    });
  },
};
