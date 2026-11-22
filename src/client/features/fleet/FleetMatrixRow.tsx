import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  ArrowUpRight,
  ExternalLink,
  Minus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { FleetDomainSummary } from "@/server/features/fleet/services/FleetService";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { TableCell, TableHead, TableRow } from "@/client/components/ui/table";

import { EvidenceDisclosure } from "./FleetEvidenceDisclosure";

function StatusBadge({ status }: { status: FleetDomainSummary["status"] }) {
  if (status === "fresh_graded") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-xs text-card-foreground"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 size-2 rounded-full bg-emerald-500"
        />
        Graded
      </Badge>
    );
  }
  if (status === "fresh_partial") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-xs text-card-foreground"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 size-2 rounded-full bg-amber-500"
        />
        Partial
      </Badge>
    );
  }
  if (status === "stale") {
    return (
      <Badge
        variant="outline"
        className="border-orange-500/30 bg-orange-500/10 text-xs text-card-foreground"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 size-2 rounded-full bg-orange-500"
        />
        Stale
      </Badge>
    );
  }
  if (status === "exempt") {
    return (
      <Badge
        variant="outline"
        className="border-purple-500/30 bg-purple-500/10 text-xs text-card-foreground"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 size-2 rounded-full bg-purple-500"
        />
        Exempt
      </Badge>
    );
  }
  if (status === "unavailable") {
    return (
      <Badge
        variant="outline"
        className="border-rose-500/30 bg-rose-500/10 text-xs text-card-foreground"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 size-2 rounded-full bg-rose-500"
        />
        Unavailable
      </Badge>
    );
  }
  if (status === "unmapped") {
    return (
      <Badge
        variant="outline"
        className="border-slate-500/30 bg-slate-500/10 text-xs text-card-foreground"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 size-2 rounded-full bg-slate-500"
        />
        Unmapped
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-slate-500/30 bg-slate-500/10 text-xs text-card-foreground"
    >
      <span
        aria-hidden="true"
        className="mr-1.5 size-2 rounded-full bg-slate-400"
      />
      Never Audited
    </Badge>
  );
}

export function FleetMatrixRow({ domain }: { domain: FleetDomainSummary }) {
  const isValidHost =
    typeof domain.canonicalHost === "string" &&
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      domain.canonicalHost,
    );

  return (
    <TableRow key={domain.memberId}>
      <TableHead scope="row" className="font-medium text-foreground">
        <div className="flex items-center gap-1.5">
          <span>{domain.canonicalHost}</span>
          {domain.hasIncidentCap && (
            <Badge
              variant="outline"
              className="border-rose-500/30 bg-rose-500/10 text-[10px] font-semibold text-card-foreground"
            >
              <span
                aria-hidden="true"
                className="mr-1 size-1.5 rounded-full bg-rose-500"
              />
              Critical Flag
            </Badge>
          )}
          {isValidHost && (
            <a
              href={`https://${encodeURIComponent(domain.canonicalHost)}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open https://${domain.canonicalHost} in new tab`}
              className="inline-flex min-h-9 min-w-9 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          )}
        </div>
        <EvidenceDisclosure domain={domain} />
      </TableHead>

      <TableCell>
        <span className="inline-flex items-center gap-1 text-xs">
          <span>{domain.categoryEmoji}</span>
          <span>{domain.category}</span>
        </span>
      </TableCell>

      <TableCell>
        <Badge
          variant="outline"
          className={cn(
            "text-xs font-medium",
            domain.tier === "Tier 1" &&
              "border-primary/40 bg-primary/10 text-foreground dark:text-foreground font-semibold",
            domain.tier === "Tier 2" &&
              "border-border bg-muted/60 text-muted-foreground",
          )}
        >
          {domain.tier === "Tier 1" && (
            <span
              aria-hidden="true"
              className="mr-1 size-1.5 rounded-full bg-primary"
            />
          )}
          {domain.tier}
        </Badge>
      </TableCell>

      <TableCell className="text-xs text-muted-foreground">
        {domain.platform === "wordpress_static" ||
        domain.platform === "wp_static"
          ? "WordPress static"
          : domain.platform === "astro"
            ? "Astro"
            : domain.platform === "react_spa"
              ? "React SPA"
              : "Custom"}
      </TableCell>

      <TableCell className="text-center font-semibold tabular-nums">
        {domain.score !== null ? (
          <span className="text-card-foreground font-semibold">
            {domain.score}
          </span>
        ) : domain.lastGoodScore !== null ? (
          <div className="flex flex-col items-center">
            <span className="text-xs text-muted-foreground">—</span>
            <span
              className="text-xs text-muted-foreground"
              title={`Last good official score: ${domain.lastGoodScore}`}
            >
              Last: {domain.lastGoodScore}
            </span>
            {domain.lastGoodObservedAt && (
              <time
                dateTime={domain.lastGoodObservedAt}
                className="text-xs tabular-nums text-muted-foreground"
              >
                {new Intl.DateTimeFormat("en-GB", {
                  timeZone: "Asia/Jakarta",
                  dateStyle: "short",
                }).format(new Date(domain.lastGoodObservedAt))}
              </time>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="text-center">
        <Badge
          variant="outline"
          className={
            domain.grade === "A"
              ? "border-emerald-500/30 bg-emerald-500/10 text-card-foreground"
              : domain.grade === "B"
                ? "border-blue-500/30 bg-blue-500/10 text-card-foreground"
                : domain.grade === "C"
                  ? "border-amber-500/30 bg-amber-500/10 text-card-foreground"
                  : domain.grade === "D"
                    ? "border-orange-500/30 bg-orange-500/10 text-card-foreground"
                    : domain.grade === "F"
                      ? "border-rose-500/30 bg-rose-500/10 text-card-foreground"
                      : "text-muted-foreground"
          }
        >
          {domain.grade !== "ungraded" && (
            <span
              aria-hidden="true"
              className={`mr-1 size-2 rounded-full ${
                domain.grade === "A"
                  ? "bg-emerald-500"
                  : domain.grade === "B"
                    ? "bg-blue-500"
                    : domain.grade === "C"
                      ? "bg-amber-500"
                      : domain.grade === "D"
                        ? "bg-orange-500"
                        : "bg-rose-500"
              }`}
            />
          )}
          {domain.grade}
        </Badge>
      </TableCell>

      <TableCell className="text-center">
        <StatusBadge status={domain.status} />
      </TableCell>

      <TableCell className="text-center tabular-nums">
        {domain.trendDelta !== null ? (
          domain.trendDelta > 0 ? (
            <span className="inline-flex items-center text-xs font-semibold text-card-foreground">
              <TrendingUp
                className="mr-0.5 size-3.5 text-emerald-500"
                aria-hidden="true"
              />
              +{domain.trendDelta}
            </span>
          ) : domain.trendDelta < 0 ? (
            <span className="inline-flex items-center text-xs font-semibold text-card-foreground">
              <TrendingDown
                className="mr-0.5 size-3.5 text-rose-500"
                aria-hidden="true"
              />
              {domain.trendDelta}
            </span>
          ) : (
            <span className="inline-flex items-center text-xs text-muted-foreground">
              <Minus className="mr-0.5 size-3.5" aria-hidden="true" />0
            </span>
          )
        ) : (
          <span className="inline-flex items-center text-xs text-muted-foreground">
            —
          </span>
        )}
      </TableCell>

      <TableCell className="text-right text-xs tabular-nums">
        {domain.coverage !== null ? `${domain.coverage}%` : "—"}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {domain.scoreTechnical !== null
          ? `${Math.round(domain.scoreTechnical)}%`
          : "—"}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {domain.scoreInternalLinks !== null
          ? `${Math.round(domain.scoreInternalLinks)}%`
          : "—"}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {domain.scoreMobilePerf !== null
          ? `${Math.round(domain.scoreMobilePerf)}%`
          : "—"}
      </TableCell>

      <TableCell className="text-right">
        {domain.projectId ? (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-9"
            aria-label={`View audit report for ${domain.canonicalHost}`}
            nativeButton={false}
            render={
              <Link
                to="/p/$projectId/audit"
                params={{ projectId: domain.projectId }}
              />
            }
          >
            Audit
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Unlinked</span>
        )}
      </TableCell>
    </TableRow>
  );
}
