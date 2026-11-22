import type { FleetDomainSummary } from "@/server/features/fleet/services/FleetService";

export function EvidenceDisclosure({ domain }: { domain: FleetDomainSummary }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="min-h-9 cursor-pointer py-1.5 font-medium text-foreground focus-visible:outline-2">
        Evidence for {domain.canonicalHost}
      </summary>
      <div className="space-y-1 py-1 pl-2 text-muted-foreground">
        <p>Category: {domain.category}</p>
        <p>
          Tier: {domain.tier} · Platform: {domain.platform}
        </p>
        <p>
          Coverage: {domain.coverage !== null ? `${domain.coverage}%` : "—"}
        </p>
        {domain.provisionalRange && (
          <p>
            Provisional Range: [{domain.provisionalRange.lower},{" "}
            {domain.provisionalRange.upper}]
          </p>
        )}
        <p>
          Technical:{" "}
          {domain.scoreTechnical !== null ? `${domain.scoreTechnical}%` : "—"}
        </p>
        <p>
          Internal Links:{" "}
          {domain.scoreInternalLinks !== null
            ? `${domain.scoreInternalLinks}%`
            : "—"}
        </p>
        <p>
          Mobile Perf:{" "}
          {domain.scoreMobilePerf !== null ? `${domain.scoreMobilePerf}%` : "—"}
        </p>
        <p>
          On-Page:{" "}
          {domain.scoreOnPage !== null ? `${domain.scoreOnPage}%` : "—"}
        </p>
        <p>
          Schema: {domain.scoreSchema !== null ? `${domain.scoreSchema}%` : "—"}
        </p>
        <p>
          AI Readiness:{" "}
          {domain.scoreAiReadiness !== null
            ? `${domain.scoreAiReadiness}%`
            : "—"}
        </p>
        {domain.latestAttemptAt && (
          <p>
            Latest attempt:{" "}
            <time dateTime={domain.latestAttemptAt}>
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Jakarta",
                dateStyle: "medium",
              }).format(new Date(domain.latestAttemptAt))}
            </time>
          </p>
        )}
        {domain.lastObservedAt && (
          <p>
            Observed:{" "}
            <time dateTime={domain.lastObservedAt}>
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Jakarta",
                dateStyle: "medium",
              }).format(new Date(domain.lastObservedAt))}
            </time>
          </p>
        )}
        {domain.lastGoodScore !== null && domain.lastGoodObservedAt && (
          <p>
            Last good: {domain.lastGoodScore} on{" "}
            <time dateTime={domain.lastGoodObservedAt}>
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Jakarta",
                dateStyle: "medium",
              }).format(new Date(domain.lastGoodObservedAt))}
            </time>
          </p>
        )}
      </div>
    </details>
  );
}
