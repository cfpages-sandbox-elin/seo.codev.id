import { queryOptions } from "@tanstack/react-query";
import { getFleetOverview } from "@/serverFunctions/fleet";
import type { FleetOverviewData } from "@/server/features/fleet/services/FleetService";
import { getErrorCode } from "@/client/lib/error-messages";

export function fleetOverviewQueryOptions(workspaceId?: string) {
  return queryOptions<FleetOverviewData>({
    queryKey: ["fleet", "overview", workspaceId ?? "active"],
    queryFn: () =>
      getFleetOverview({
        data: workspaceId ? { expectedOrganizationId: workspaceId } : undefined,
      }),
    staleTime: 60_000,
    retry(failureCount, error) {
      const code = getErrorCode(error);
      if (
        code === "NOT_FOUND" ||
        code === "FORBIDDEN" ||
        code === "UNAUTHENTICATED"
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
