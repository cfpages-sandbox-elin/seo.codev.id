import { Layers, ShieldAlert, TrendingUp } from "lucide-react";
import type { FleetOverviewData } from "@/server/features/fleet/services/FleetService";
import { Badge } from "@/client/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";

export function FleetMetricCards({ data }: { data: FleetOverviewData }) {
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Monitored Fleet</CardDescription>
          <CardTitle className="flex items-center justify-between text-2xl font-bold tabular-nums">
            <span>{data.totalDomains} Domains</span>
            <Layers className="size-5 text-muted-foreground" />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-card-foreground font-medium">
          Manifest Version: {data.rosterVersion}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Median Health Score</CardDescription>
          <CardTitle className="flex items-center justify-between text-2xl font-bold tabular-nums">
            <span>
              {data.medianScore !== null
                ? `${data.medianScore} / 100`
                : "Baseline Pending"}
            </span>
            <TrendingUp className="size-5 text-emerald-500" />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-card-foreground font-medium tabular-nums">
          {data.gradedCount} of {data.totalDomains} properties graded
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Critical Flags</CardDescription>
          <CardTitle className="flex items-center justify-between text-2xl font-bold tabular-nums">
            <span
              className={
                data.criticalIncidentsCount > 0
                  ? "text-destructive"
                  : "text-foreground"
              }
            >
              {data.criticalIncidentsCount}
            </span>
            <ShieldAlert
              className={`size-5 ${
                data.criticalIncidentsCount > 0
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-card-foreground font-medium">
          Domains with a current critical flag
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Grade Distribution</CardDescription>
          <CardTitle className="flex flex-wrap items-center gap-1 text-xs font-medium tabular-nums">
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-card-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1 size-1.5 rounded-full bg-emerald-500"
              />
              A: {data.gradeDistribution.A}
            </Badge>
            <Badge
              variant="outline"
              className="border-blue-500/30 bg-blue-500/10 text-card-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1 size-1.5 rounded-full bg-blue-500"
              />
              B: {data.gradeDistribution.B}
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-card-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1 size-1.5 rounded-full bg-amber-500"
              />
              C: {data.gradeDistribution.C}
            </Badge>
            <Badge
              variant="outline"
              className="border-orange-500/30 bg-orange-500/10 text-card-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1 size-1.5 rounded-full bg-orange-500"
              />
              D: {data.gradeDistribution.D}
            </Badge>
            <Badge
              variant="outline"
              className="border-rose-500/30 bg-rose-500/10 text-card-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1 size-1.5 rounded-full bg-rose-500"
              />
              F: {data.gradeDistribution.F}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Ungraded: {data.gradeDistribution.ungraded}
        </CardContent>
      </Card>
    </div>
  );
}
