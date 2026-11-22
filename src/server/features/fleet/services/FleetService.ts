import { sort } from "remeda";
import {
  FleetRepository,
  type RawFleetMember,
  type RawFleetRunItem,
} from "../repositories/FleetRepository";
import { FLEET_MANIFEST_VERSION } from "../data/fleetManifest";
import {
  deriveDisposition,
  officialPoint,
  computeTrendDelta,
  calculateMedian,
  parseUtcTimestampMs,
  parseIncidentConfirmation,
  computeProvisionalRange,
  type ProvisionalRange,
  type OfficialPoint,
} from "./fleetCalculations";
import {
  type SnapshotAttemptOverlay,
  resolveTerminalAttempts,
  resolveAdmittedObservations,
  extractPillars,
} from "./fleetObservations";

export type { SnapshotAttemptOverlay } from "./fleetObservations";

export interface FleetDomainSummary {
  memberId: string;
  canonicalHost: string;
  category: string;
  categoryEmoji: string;
  tier: string;
  siteIntent: string;
  platform: string;
  repoName: string | null;
  projectId: string | null;
  score: number | null;
  lastGoodScore: number | null;
  lastGoodObservedAt: string | null;
  grade: string;
  trendDelta: number | null;
  coverage: number | null;
  hasIncidentCap: boolean;
  scoreTechnical: number | null;
  scoreInternalLinks: number | null;
  scoreMobilePerf: number | null;
  scoreOnPage: number | null;
  scoreSchema: number | null;
  scoreAiReadiness: number | null;
  provisionalRange: ProvisionalRange | null;
  lastObservedAt: string | null;
  latestAttemptAt?: string | null;
  status:
    | "fresh_graded"
    | "fresh_partial"
    | "stale"
    | "never_audited"
    | "unmapped"
    | "exempt"
    | "unavailable";
}

export interface FleetOverviewData {
  rosterVersion: string;
  totalDomains: number;
  gradedCount: number;
  medianScore: number | null;
  criticalIncidentsCount: number;
  gradeDistribution: {
    A: number;
    B: number;
    C: number;
    D: number;
    F: number;
    ungraded: number;
  };
  domains: FleetDomainSummary[];
}

interface MemberEvaluation {
  summary: FleetDomainSummary;
  officialScore: number | null;
  hasIncidentCap: boolean;
  officialGrade: string;
}

function evaluateMember(
  member: RawFleetMember,
  memberRunItems: RawFleetRunItem[],
  memberSnaps: SnapshotAttemptOverlay[],
  now: number,
): MemberEvaluation {
  // Scope attempts strictly to the member's approved project (Sol P1-3)
  const scopedItems = memberRunItems.filter(
    (item) => member.projectId !== null && item.projectId === member.projectId,
  );

  const { admittedItemById, admittedTerminalAttempts } =
    resolveTerminalAttempts(scopedItems, now);

  const admittedObservations = resolveAdmittedObservations(
    memberSnaps,
    member.projectId,
    admittedItemById,
    now,
    member.canonicalHost,
  );

  // Admitted weekly baseline observations (Sol P1-2):
  const admittedWeeklyObservations = admittedObservations.filter(
    ({ snap }) => snap.seriesKey === "weekly-baseline",
  );

  // Latest weekly baseline attempt (Sol F02):
  // Filter attempts where primarySeriesKey is weekly-baseline (or null legacy with no diagnostic snapshots)
  const latestWeeklyAttempt =
    admittedTerminalAttempts.find(({ item }) => {
      if (item.primarySeriesKey) {
        return item.primarySeriesKey === "weekly-baseline";
      }
      // If primarySeriesKey is unset, inspect if its snapshots were explicitly diagnostic
      const snaps = memberSnaps.filter((s) => s.runItemId === item.id);
      if (
        snaps.length > 0 &&
        snaps.every((s) => s.seriesKey === "diagnostic")
      ) {
        return false;
      }
      return true;
    })?.item ?? null;

  // Snapshot selection (Sol P1-2, P1-3, F01, F02):
  // If latest terminal attempt of the weekly series completed without an admitted observation, treat as unavailable (do not show prior stale snapshot under latest attempt)
  // If latest terminal attempt of the weekly series is partial, use strictly its own observation or null (never borrow prior snapshot)
  // For baseline overview, select the latest admitted weekly baseline snapshot
  const latestObservation = admittedWeeklyObservations.find(
    ({ snap }) => snap.runItemId === latestWeeklyAttempt?.id,
  );
  const completedWithoutObservation =
    latestWeeklyAttempt?.status === "completed" && !latestObservation;

  const currentSnapshot = completedWithoutObservation
    ? null
    : latestWeeklyAttempt?.status === "partial"
      ? (latestObservation?.snap ?? null)
      : (admittedWeeklyObservations[0]?.snap ?? null);

  const currentParent = currentSnapshot
    ? admittedItemById.get(currentSnapshot.runItemId)
    : null;

  const currentOfficial =
    member.projectId && currentSnapshot
      ? officialPoint(
          currentSnapshot,
          member.projectId,
          now,
          currentParent?.item.status,
          member.canonicalHost,
        )
      : null;

  // Weekly disposition receives latestWeeklyAttempt alone per PRD §2 (Sol F02, F01)
  const disposition = completedWithoutObservation
    ? "unavailable"
    : deriveDisposition(
        member,
        currentSnapshot,
        now,
        latestWeeklyAttempt,
        currentOfficial,
      );

  let officialGrade = "ungraded";
  let displayScore: number | null = null;

  if (disposition === "fresh_graded" && currentOfficial) {
    officialGrade = currentOfficial.grade;
    displayScore = currentOfficial.score;
  }

  // Admitted weekly baseline points for last good score and trend computation (Sol P1-2, F01):
  // Only snapshots from completed parent run items are admitted into official history
  const admittedWeeklyPoints: OfficialPoint[] = member.projectId
    ? admittedWeeklyObservations
        .filter((obs) => obs.parent.item.status === "completed")
        .map(({ snap, parent }) =>
          officialPoint(
            snap,
            member.projectId,
            now,
            parent.item.status,
            member.canonicalHost,
          ),
        )
        .filter((p): p is OfficialPoint => p !== null)
    : [];

  // Last good score derived from current official or latest preceding official weekly baseline (Sol F01)
  let lastGoodScore: number | null = null;
  let lastGoodObservedAt: string | null = null;

  const effectiveGoodPoint = currentOfficial ?? admittedWeeklyPoints[0] ?? null;
  if (effectiveGoodPoint) {
    lastGoodScore = effectiveGoodPoint.score;
    lastGoodObservedAt = new Date(
      effectiveGoodPoint.observedAtMs,
    ).toISOString();
  }

  // Trend delta only emitted when disposition is fresh_graded (Sol P1-3)
  const trendDelta =
    disposition === "fresh_graded"
      ? computeTrendDelta(
          currentOfficial,
          member.projectId,
          admittedWeeklyPoints,
          now,
        )
      : null;

  const hasScores =
    currentSnapshot !== null &&
    currentSnapshot.projectId === member.projectId &&
    disposition !== "unavailable" &&
    disposition !== "unmapped" &&
    disposition !== "exempt" &&
    disposition !== "never_audited";

  const pillars = extractPillars(currentSnapshot, hasScores);

  // Critical flag: require confirmed incident evidence active at dashboard clock (Sol F05, F06)
  const currentFlag =
    (disposition === "fresh_graded" || disposition === "fresh_partial") &&
    parseIncidentConfirmation(
      currentSnapshot ?? {
        hasIncidentCap: false,
        incidentReason: null,
        observedAt: null,
      },
      now,
    );

  // Provisional interval: only exposed for valid partial dispositions with measured coverage (Sol F05)
  const provisionalRange =
    hasScores &&
    (disposition === "fresh_partial" || disposition === "stale") &&
    currentSnapshot
      ? computeProvisionalRange(currentSnapshot, currentFlag)
      : null;

  // Normalize ISO timestamps; leave null whenever observation/attempt is missing (Sol F01, F02)
  const toIso = (value: string | null | undefined): string | null => {
    const millis = parseUtcTimestampMs(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
  };
  const lastObservedAt = toIso(currentSnapshot?.observedAt);
  const latestAttemptAt = toIso(latestWeeklyAttempt?.completedAt);

  return {
    officialScore: displayScore,
    officialGrade,
    hasIncidentCap: currentFlag,
    summary: {
      memberId: member.id,
      canonicalHost: member.canonicalHost,
      category: member.category,
      categoryEmoji: member.categoryEmoji,
      tier: member.tier,
      siteIntent: member.siteIntent,
      platform: member.platform,
      repoName: member.repoName,
      projectId: member.projectId,
      score: displayScore,
      lastGoodScore,
      lastGoodObservedAt,
      grade: officialGrade,
      trendDelta,
      coverage: pillars.coverage,
      hasIncidentCap: currentFlag,
      scoreTechnical: pillars.scoreTechnical,
      scoreInternalLinks: pillars.scoreInternalLinks,
      scoreMobilePerf: pillars.scoreMobilePerf,
      scoreOnPage: pillars.scoreOnPage,
      scoreSchema: pillars.scoreSchema,
      scoreAiReadiness: pillars.scoreAiReadiness,
      provisionalRange,
      lastObservedAt,
      latestAttemptAt,
      status: disposition,
    },
  };
}

export const FleetService = {
  /**
   * Generates helicopter-view data for Syamsul Alam's 87 portfolio properties.
   */
  async getOverview(organizationId: string): Promise<FleetOverviewData> {
    const { version, members, snapshots, runItems } =
      await FleetRepository.getRawFleetData(organizationId);

    // Group snapshots and run items by member ID for O(M + S) evaluation
    const snapshotsByMember = new Map<string, SnapshotAttemptOverlay[]>();
    for (const snap of snapshots) {
      const list = snapshotsByMember.get(snap.memberId);
      if (list) {
        list.push(snap);
      } else {
        snapshotsByMember.set(snap.memberId, [snap]);
      }
    }

    const runItemsByMember = new Map<string, RawFleetRunItem[]>();
    for (const item of runItems) {
      const list = runItemsByMember.get(item.memberId);
      if (list) {
        list.push(item);
      } else {
        runItemsByMember.set(item.memberId, [item]);
      }
    }

    const domainSummaries: FleetDomainSummary[] = [];
    const validGradedScores: number[] = [];
    let criticalIncidentsCount = 0;
    const gradeDistribution = {
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      F: 0,
      ungraded: 0,
    };

    const now = Date.now();

    // Excluded members are filtered before summary, counts and scoring (Sol F10)
    const includedMembers = members.filter(
      (m) => m.enrollmentState !== "excluded",
    );

    for (const member of includedMembers) {
      const rawRunItems = runItemsByMember.get(member.id) ?? [];
      const memberRunItems = sort(rawRunItems, (a, b) => {
        const tA = parseUtcTimestampMs(a.completedAt);
        const tB = parseUtcTimestampMs(b.completedAt);
        const diff = (isNaN(tB) ? 0 : tB) - (isNaN(tA) ? 0 : tA);
        if (diff !== 0) return diff;
        return b.id.localeCompare(a.id);
      });

      const rawSnaps = snapshotsByMember.get(member.id) ?? [];
      const memberSnaps = sort(rawSnaps, (a, b) => {
        const tA = parseUtcTimestampMs(a.observedAt);
        const tB = parseUtcTimestampMs(b.observedAt);
        const diff = (isNaN(tB) ? 0 : tB) - (isNaN(tA) ? 0 : tA);
        if (diff !== 0) return diff;
        return b.id.localeCompare(a.id);
      });

      const evaluation = evaluateMember(
        member,
        memberRunItems,
        memberSnaps,
        now,
      );
      domainSummaries.push(evaluation.summary);

      if (evaluation.officialScore !== null) {
        validGradedScores.push(evaluation.officialScore);
      }
      if (evaluation.hasIncidentCap) {
        criticalIncidentsCount++;
      }

      const g = evaluation.officialGrade;
      if (g === "A" || g === "B" || g === "C" || g === "D" || g === "F") {
        gradeDistribution[g]++;
      } else {
        gradeDistribution.ungraded++;
      }
    }

    return {
      rosterVersion: version.versionTag ?? FLEET_MANIFEST_VERSION,
      totalDomains: includedMembers.length,
      gradedCount: validGradedScores.length,
      medianScore: calculateMedian(validGradedScores),
      criticalIncidentsCount,
      gradeDistribution,
      domains: domainSummaries,
    };
  },
};
