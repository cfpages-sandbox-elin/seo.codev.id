import { createFileRoute } from "@tanstack/react-router";
import { FleetOverviewView } from "@/client/features/fleet/FleetOverviewView";
import { getFleetOverview } from "@/serverFunctions/fleet";
import { getOrganizationContext } from "@/serverFunctions/organization";

export const Route = createFileRoute("/_app/onsite")({
  loader: async () => {
    try {
      const org = await getOrganizationContext();
      if (!org?.organizationId) return null;
      const overview = await getFleetOverview({
        data: { expectedOrganizationId: org.organizationId },
      });
      return {
        organizationId: org.organizationId,
        overview,
      };
    } catch {
      return null;
    }
  },
  component: OnsiteRouteComponent,
});

function OnsiteRouteComponent() {
  const loaderData = Route.useLoaderData();
  return (
    <FleetOverviewView
      initialData={loaderData?.overview}
      initialOrgId={loaderData?.organizationId}
    />
  );
}
