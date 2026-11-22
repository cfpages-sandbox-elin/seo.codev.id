import type { FleetDomainSummary } from "@/server/features/fleet/services/FleetService";
import type { SortDirection, SortField } from "./fleetTypes";

type SortValueGetter = (d: FleetDomainSummary) => string | number | null;

const sortValueMap: Record<SortField, SortValueGetter> = {
  triage: (d) => d.canonicalHost,
  host: (d) => d.canonicalHost,
  category: (d) => d.category,
  tier: (d) => d.tier,
  platform: (d) => d.platform,
  score: (d) => d.score,
  grade: (d) => d.grade,
  status: (d) => d.status,
  trend: (d) => d.trendDelta,
  coverage: (d) => d.coverage,
  crawl: (d) => d.scoreTechnical,
  links: (d) => d.scoreInternalLinks,
  lab: (d) => d.scoreMobilePerf,
};

export function compareDomains(
  a: FleetDomainSummary,
  b: FleetDomainSummary,
  sortField: SortField,
  sortDirection: SortDirection,
): number {
  if (sortField === "triage") {
    // Sol F10: Initial triage priority:
    // 1. Critical flags first
    const flagA = a.hasIncidentCap ? 1 : 0;
    const flagB = b.hasIncidentCap ? 1 : 0;
    if (flagA !== flagB) {
      return flagB - flagA;
    }
    // 2. Negative comparable deltas next
    const adverseA = a.trendDelta !== null && a.trendDelta < 0 ? 1 : 0;
    const adverseB = b.trendDelta !== null && b.trendDelta < 0 ? 1 : 0;
    if (adverseA !== adverseB) {
      return adverseB - adverseA;
    }
    // 3. Host tie-break
    return a.canonicalHost.localeCompare(b.canonicalHost);
  }

  const pick = sortValueMap[sortField];
  const left = pick ? pick(a) : null;
  const right = pick ? pick(b) : null;

  if (left === null && right === null) {
    return a.canonicalHost.localeCompare(b.canonicalHost);
  }
  if (left === null) return 1;
  if (right === null) return -1;

  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right));

  const dirComp = sortDirection === "asc" ? comparison : -comparison;
  return dirComp !== 0
    ? dirComp
    : a.canonicalHost.localeCompare(b.canonicalHost);
}
