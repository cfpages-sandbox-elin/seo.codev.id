import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { sort } from "remeda";
import { fleetOverviewQueryOptions } from "./fleetQueries";
import type {
  FleetDomainSummary,
  FleetOverviewData,
} from "@/server/features/fleet/services/FleetService";
import { organizationContextQueryOptions } from "@/client/features/team/organizationQueries";
import { getErrorCode } from "@/client/lib/error-messages";
import { PageHeader } from "@/client/components/PageHeader";
import { QueryError, QueryState } from "@/client/components/QueryState";
import { Badge } from "@/client/components/ui/badge";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/client/components/ui/alert";
import { FleetMetricCards } from "./FleetMetricCards";
import { FleetFilterToolbar } from "./FleetFilterToolbar";
import { FleetMatrixTable } from "./FleetMatrixTable";
import { compareDomains } from "./fleetSort";
import type { SortDirection, SortField } from "./fleetTypes";

export function FleetOverviewView({
  initialData,
  initialOrgId,
}: {
  initialData?: FleetOverviewData;
  initialOrgId?: string;
} = {}) {
  const orgContextQuery = useQuery(organizationContextQueryOptions());
  const activeOrganizationId = orgContextQuery.isSuccess
    ? orgContextQuery.data.organizationId
    : initialOrgId;

  const fleetQuery = useQuery({
    ...fleetOverviewQueryOptions(activeOrganizationId),
    enabled: Boolean(activeOrganizationId),
    initialData:
      activeOrganizationId && activeOrganizationId === initialOrgId
        ? initialData
        : undefined,
  });

  const [search, setSearch] = React.useState("");
  const [selectedTier, setSelectedTier] = React.useState<string>("all");
  const [selectedGrade, setSelectedGrade] = React.useState<string>("all");
  const [selectedStatus, setSelectedStatus] = React.useState<string>("all");
  const [sortField, setSortField] = React.useState<SortField>("triage");
  const [sortDirection, setSortDirection] =
    React.useState<SortDirection>("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <PageHeader
            title="Aggregated Fleet View"
            description="Helicopter view and technical SEO health tracking across Syamsul Alam's 87 owned commercial properties."
          />
          <Badge
            variant="outline"
            className="w-fit border-amber-500/30 bg-amber-500/10 text-xs text-card-foreground"
          >
            <span
              aria-hidden="true"
              className="mr-1 size-1.5 rounded-full bg-amber-500"
            />
            Preview Contract
          </Badge>
        </div>

        {orgContextQuery.isPending && (
          <div className="space-y-4" role="status" aria-live="polite">
            <span className="sr-only">Loading workspace context...</span>
            <Skeleton className="h-28 w-full rounded-lg" />
            <Skeleton className="h-96 w-full rounded-lg" />
          </div>
        )}

        {orgContextQuery.isError && (
          <QueryError
            error={orgContextQuery.error}
            fallback="Could not load workspace"
            onRetry={() => void orgContextQuery.refetch()}
          />
        )}

        {!orgContextQuery.isPending &&
          !orgContextQuery.isError &&
          !activeOrganizationId && (
            <Alert variant="info">
              <AlertTitle>Workspace required</AlertTitle>
              <AlertDescription>
                Please select an organization workspace from the workspace
                switcher to view fleet health.
              </AlertDescription>
            </Alert>
          )}

        {activeOrganizationId &&
          !orgContextQuery.isPending &&
          (() => {
            const code = getErrorCode(fleetQuery.error);
            if (code === "NOT_FOUND") {
              return (
                <Alert variant="info">
                  <AlertTitle>Fleet roster approval pending</AlertTitle>
                  <AlertDescription>
                    The canonical 87-domain portfolio manifest has not yet been
                    approved for this organization.
                  </AlertDescription>
                </Alert>
              );
            }
            if (code === "FORBIDDEN") {
              return (
                <Alert variant="warning">
                  <AlertTitle>Fleet view unavailable</AlertTitle>
                  <AlertDescription>
                    Fleet view is not enabled for this workspace or your role
                    does not have viewing permissions.
                  </AlertDescription>
                </Alert>
              );
            }
            if (code === "UNAUTHENTICATED") {
              return (
                <Alert variant="warning">
                  <AlertTitle>Authentication required</AlertTitle>
                  <AlertDescription>
                    Please sign in to access the fleet overview.
                  </AlertDescription>
                </Alert>
              );
            }

            return (
              <QueryState
                query={fleetQuery}
                errorFallback="Failed to load fleet overview"
                loading={
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex min-h-[300px] flex-col items-center justify-center space-y-4"
                  >
                    <div className="h-8 w-8 animate-spin motion-reduce:animate-none rounded-full border-4 border-primary border-t-transparent" />
                    <span className="text-sm font-medium text-muted-foreground">
                      Loading fleet overview data...
                    </span>
                  </div>
                }
              >
                {(data: FleetOverviewData) => {
                  const filteredDomains: FleetDomainSummary[] =
                    data.domains.filter((d: FleetDomainSummary) => {
                      const matchesSearch =
                        d.canonicalHost
                          .toLowerCase()
                          .includes(search.toLowerCase()) ||
                        d.category.toLowerCase().includes(search.toLowerCase());
                      const matchesTier =
                        selectedTier === "all" || d.tier === selectedTier;
                      const matchesGrade =
                        selectedGrade === "all" || d.grade === selectedGrade;
                      const matchesStatus =
                        selectedStatus === "all" || d.status === selectedStatus;
                      return (
                        matchesSearch &&
                        matchesTier &&
                        matchesGrade &&
                        matchesStatus
                      );
                    });

                  const sortedDomains: FleetDomainSummary[] = sort(
                    filteredDomains,
                    (a, b) => compareDomains(a, b, sortField, sortDirection),
                  );

                  return (
                    <div className="space-y-6">
                      <FleetMetricCards data={data} />
                      <FleetFilterToolbar
                        search={search}
                        setSearch={setSearch}
                        selectedTier={selectedTier}
                        setSelectedTier={setSelectedTier}
                        selectedGrade={selectedGrade}
                        setSelectedGrade={setSelectedGrade}
                        selectedStatus={selectedStatus}
                        setSelectedStatus={setSelectedStatus}
                      />
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs text-muted-foreground">
                        <p role="status">
                          {data.totalDomains === 0
                            ? "No enrolled properties in this roster."
                            : sortedDomains.length === 0
                              ? "No properties match these filters."
                              : `Showing ${sortedDomains.length} of ${data.totalDomains} properties`}
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-disabled={sortField === "triage"}
                            disabled={sortField === "triage"}
                            className={
                              sortField === "triage"
                                ? "text-muted-foreground/50 cursor-default"
                                : "font-medium text-primary hover:underline cursor-pointer"
                            }
                            onClick={() => {
                              if (sortField !== "triage") {
                                setSortField("triage");
                                setSortDirection("asc");
                              }
                            }}
                          >
                            Reset to triage priority
                          </button>
                          <span>
                            Select a table header to sort. Missing scores sort
                            last.
                          </span>
                        </div>
                      </div>
                      <FleetMatrixTable
                        domains={sortedDomains}
                        sortField={sortField}
                        sortDirection={sortDirection}
                        onSort={handleSort}
                      />
                    </div>
                  );
                }}
              </QueryState>
            );
          })()}
      </div>
    </div>
  );
}
