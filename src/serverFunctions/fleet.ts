import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { FleetService } from "@/server/features/fleet/services/FleetService";
import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { hasOrgPermission } from "@/lib/org-permissions";

const fleetInput = z
  .object({
    expectedOrganizationId: z.string().trim().min(1).optional(),
  })
  .strict()
  .optional();

export const getFleetOverview = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator((input: unknown) => fleetInput.parse(input))
  .handler(async ({ context, data }) => {
    const orgId = context?.organizationId;
    if (!orgId) {
      throw new AppError(
        "FORBIDDEN",
        "Active organization required for fleet access",
      );
    }

    const enabled =
      (await getOptionalEnvValue("FEATURE_FLEET_VIEW"))
        ?.trim()
        .toLowerCase() === "true";
    const allowedOrg = (
      await getOptionalEnvValue("FLEET_VIEW_ORGANIZATION_ID")
    )?.trim();

    // Strict entitlement policy adhering to Sol PV-5 / P2-1:
    // 1. Feature flag enabled
    // 2. Organization matches allowedOrg
    // 3. Expected organization ID consistency check (if supplied)
    // 4. Role authorization strictly via hasOrgPermission
    if (
      !enabled ||
      !allowedOrg ||
      orgId !== allowedOrg ||
      (data?.expectedOrganizationId !== undefined &&
        data.expectedOrganizationId !== orgId) ||
      !hasOrgPermission(context.role, { fleet: ["view"] })
    ) {
      throw new AppError("FORBIDDEN", "Fleet view is unavailable");
    }

    return FleetService.getOverview(orgId);
  });
