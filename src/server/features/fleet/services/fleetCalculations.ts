import type {
  RawFleetMember,
  RawFleetSnapshot,
} from "../repositories/FleetRepository";
import type {
  FleetDomainSummary,
  SnapshotAttemptOverlay,
} from "./FleetService";
import {
  parseIncidentConfirmation,
  isValidVerifiedComparabilityKey,
  computeVerifiedComparisonKey,
} from "./fleetEvidence";
import {
  FRESHNESS_WINDOW_MS,
  COMPARABLE_BASELINE_WINDOW_MS,
  parseUtcTimestampMs,
  measuredPercent,
  gradeFor,
  calculateMedian,
  computeCanonicalRubricV1Score,
} from "./fleetConstants";

export {
  FRESHNESS_WINDOW_MS,
  COMPARABLE_BASELINE_WINDOW_MS,
  parseUtcTimestampMs,
  compareUtf8Binary,
  measuredPercent,
  gradeFor,
  calculateMedian,
  computeCanonicalRubricV1Score,
} from "./fleetConstants";

export {
  parseIncidentConfirmation,
  computeProvisionalRange,
  computeVerifiedComparisonKey,
  type ProvisionalRange,
} from "./fleetEvidence";

function hasCompletedEnvelope(
  snap: RawFleetSnapshot | SnapshotAttemptOverlay,
  parentStatus?: string | null,
): boolean {
  if (
    parentStatus !== undefined &&
    parentStatus !== null &&
    parentStatus !== "completed"
  ) {
    return false;
  }
  if (
    "attemptStatus" in snap &&
    snap.attemptStatus &&
    snap.attemptStatus !== "completed"
  ) {
    return false;
  }
  if (
    "attemptOutcome" in snap &&
    snap.attemptOutcome &&
    snap.attemptOutcome !== "completed"
  ) {
    return false;
  }
  return true;
}

interface SnapshotPillars {
  scoreTechnical: number;
  scoreMobilePerf: number;
  scoreSchema: number;
  scoreOnPage: number;
  scoreAiReadiness: number;
  scoreInternalLinks: number;
}

function hasValidPillars<T extends RawFleetSnapshot | SnapshotAttemptOverlay>(
  snap: T,
): snap is T & SnapshotPillars {
  if (
    snap.scoreTechnical === null ||
    snap.scoreInternalLinks === null ||
    snap.scoreMobilePerf === null ||
    snap.scoreOnPage === null ||
    snap.scoreSchema === null ||
    snap.scoreAiReadiness === null
  ) {
    return false;
  }
  const pillars = [
    snap.scoreTechnical,
    snap.scoreInternalLinks,
    snap.scoreMobilePerf,
    snap.scoreOnPage,
    snap.scoreSchema,
    snap.scoreAiReadiness,
  ];
  return pillars.every(
    (v) => v !== undefined && Number.isFinite(v) && v >= 0 && v <= 100,
  );
}

/**
 * Validates whether a snapshot point qualifies as an official baseline score (Sol P1-1, P1-2, F01, F04, F05).
 */
export function officialPoint(
  snap: RawFleetSnapshot | SnapshotAttemptOverlay,
  memberProjectId: string | null,
  nowMs = Date.now(),
  parentStatus?: string | null,
  memberCanonicalHost?: string | null,
) {
  if (!memberProjectId || snap.projectId !== memberProjectId) {
    return null;
  }

  // Sol F01: Canonical host must match approved member canonical host
  if (
    memberCanonicalHost &&
    snap.canonicalHost &&
    snap.canonicalHost.trim().toLowerCase() !==
      memberCanonicalHost.trim().toLowerCase()
  ) {
    return null;
  }

  // Sol F01: Only completed parent envelopes can produce official points
  if (!hasCompletedEnvelope(snap, parentStatus)) {
    return null;
  }

  // Sol P1-2: Weekly baseline exclusivity; non-baseline points (diagnostic, etc.) are excluded
  if (snap.seriesKey !== "weekly-baseline") {
    return null;
  }

  // Sol P1-1: Reject unknown rubrics at the official point boundary
  if (
    "rubricVersion" in snap &&
    snap.rubricVersion &&
    snap.rubricVersion !== "v1"
  ) {
    return null;
  }

  // 100% non-provisional coverage required for official baseline score (PRD §3)
  if (snap.coverage !== 100 || snap.isProvisional) {
    return null;
  }

  // All six pillars must be measured and valid non-null (Sol P1-5, F01)
  if (!hasValidPillars(snap)) {
    return null;
  }

  const observedTime = parseUtcTimestampMs(snap.observedAt);
  if (isNaN(observedTime) || observedTime > nowMs) {
    return null;
  }

  // Exact Rubric v1 integer arithmetic using hundredths units (Sol F04)
  const canonical = computeCanonicalRubricV1Score({
    technical: snap.scoreTechnical,
    mobilePerf: snap.scoreMobilePerf,
    schema: snap.scoreSchema,
    onPage: snap.scoreOnPage,
    ai: snap.scoreAiReadiness,
    links: snap.scoreInternalLinks,
  });

  // Historical score cap: validated against observation time (Sol F06)
  const confirmedCap = parseIncidentConfirmation(snap, observedTime);

  // If unconfirmed cap reduced the score to <= 59 artificially, keep it ungraded unless it reconciles without cap
  if (snap.hasIncidentCap && !confirmedCap && snap.score <= 59) {
    if (
      snap.score !== canonical.flooredScore &&
      Math.abs(snap.score - canonical.exactScore) > 1e-7
    ) {
      return null;
    }
  }

  const rawScore = confirmedCap
    ? Math.min(59, canonical.exactScore)
    : canonical.exactScore;
  const expectedFlooredScore = confirmedCap
    ? Math.min(59, canonical.flooredScore)
    : canonical.flooredScore;
  const grade = gradeFor(expectedFlooredScore);

  // Numerical score bounds
  if (
    snap.score === null ||
    !Number.isFinite(snap.score) ||
    snap.score < 0 ||
    snap.score > 100 ||
    (snap.hasIncidentCap && snap.score > 59)
  ) {
    return null;
  }

  // Reconcile stored score with floored or raw score
  const isFlooredMatch = snap.score === expectedFlooredScore;
  const isRawMatch = Math.abs(snap.score - rawScore) < 1e-7;

  if (!isFlooredMatch && !isRawMatch) {
    return null;
  }

  if (snap.grade !== grade) {
    return null;
  }

  return {
    ...snap,
    rawScore,
    score: expectedFlooredScore,
    grade,
    hasIncidentCap: confirmedCap,
    observedAtMs: observedTime,
    comparabilityKey: snap.comparabilityKey ?? null,
    seriesKey: snap.seriesKey ?? null,
    rubricVersion:
      "rubricVersion" in snap && typeof snap.rubricVersion === "string"
        ? snap.rubricVersion
        : "v1",
  };
}

export type OfficialPoint = NonNullable<ReturnType<typeof officialPoint>>;

function isFailedAttempt(
  latestTerminalAttempt?: {
    status?: string | null;
    errorCode?: string | null;
    completedAt?: string | null;
  } | null,
  snap?: SnapshotAttemptOverlay | null,
): boolean {
  return Boolean(
    latestTerminalAttempt?.status === "failed" ||
    snap?.status === "failed" ||
    snap?.status === "error" ||
    snap?.attemptOutcome === "failed" ||
    (snap?.attemptStatus && snap.attemptStatus === "failed"),
  );
}

/**
 * Strict 7-disposition precedence adhering strictly to PRD §2 (Sol P1-1, P1-3, PV-3):
 * 1. unmapped (no projectId bound)
 * 2. exempt (enrollmentState === "exempt" or Tier 4)
 * 3. unavailable (latest attempt failed or error)
 * 4. never_audited (no snapshot present or project mismatch)
 * 5. stale (older than 10 days or invalid timestamp)
 * 6. fresh_partial (coverage < 100, provisional, missing pillars, or non-reconciled)
 * 7. fresh_graded (100% coverage, official grade agreement, <= 10 days old)
 */
export function deriveDisposition(
  member: RawFleetMember,
  currentSnapshot: RawFleetSnapshot | SnapshotAttemptOverlay | null,
  now: number,
  latestTerminalAttempt?: {
    status?: string | null;
    errorCode?: string | null;
    completedAt?: string | null;
  } | null,
  currentOfficialPoint?: ReturnType<typeof officialPoint> | null,
): FleetDomainSummary["status"] {
  // 1. Unmapped per PRD §2
  if (!member.projectId) {
    return "unmapped";
  }

  // 2. Exempt per PRD §2
  if (
    member.enrollmentState === "exempt" ||
    (member.tier as string) === "Tier 4" ||
    (member.tier as string) === "tier4"
  ) {
    return "exempt";
  }

  // 3. Unavailable / failed attempt or completed without observation (Sol R16 F01)
  const snap = currentSnapshot as SnapshotAttemptOverlay | null;
  if (
    isFailedAttempt(latestTerminalAttempt, snap) ||
    (latestTerminalAttempt?.status === "completed" && !currentSnapshot)
  ) {
    return "unavailable";
  }

  // 4. Latest terminal attempt is partial (Sol P1-3)
  if (latestTerminalAttempt?.status === "partial") {
    const atStr = snap?.observedAt ?? latestTerminalAttempt.completedAt;
    const atMs = parseUtcTimestampMs(atStr);
    if (isNaN(atMs) || atMs > now || now - atMs > FRESHNESS_WINDOW_MS) {
      return "stale";
    }
    return "fresh_partial";
  }

  if (!currentSnapshot) {
    return "never_audited";
  }

  // Project mismatch: if latest snapshot belongs to an older/unmatched project
  if (currentSnapshot.projectId !== member.projectId) {
    return "never_audited";
  }

  // 5. Freshness check (10-day weekly freshness policy)
  const observedTime = parseUtcTimestampMs(currentSnapshot.observedAt);
  const ageMs = now - observedTime;
  const isFresh =
    !isNaN(observedTime) && observedTime <= now && ageMs <= FRESHNESS_WINDOW_MS;

  if (!isFresh) {
    return "stale";
  }

  // 6. Fresh graded if official point reconciles; otherwise fresh_partial (Sol P1-1)
  const official =
    currentOfficialPoint !== undefined
      ? currentOfficialPoint
      : officialPoint(currentSnapshot, member.projectId, now);

  return official !== null ? "fresh_graded" : "fresh_partial";
}

/**
 * Computes trend delta between current official weekly point and immediately preceding
 * official weekly point (Sol P1-2, P1-3, F01, F11).
 * Requires seriesKey === "weekly-baseline", matching verified comparabilityKey,
 * matching rubricVersion, and observation gap within 21 days.
 */
export function computeTrendDelta(
  currentOfficial: OfficialPoint | null,
  memberProjectId: string | null,
  admittedWeeklyPoints: readonly (
    | OfficialPoint
    | RawFleetSnapshot
    | SnapshotAttemptOverlay
  )[],
  now = Date.now(),
): number | null {
  if (!currentOfficial || !memberProjectId) return null;

  // Series check: weekly-baseline is the only series for baseline trends (Sol P1-2)
  if (currentOfficial.seriesKey !== "weekly-baseline") {
    return null;
  }

  const currentIndex = admittedWeeklyPoints.findIndex(
    (s) => s && "id" in s && s.id === currentOfficial.id,
  );
  const candidates =
    currentIndex >= 0
      ? admittedWeeklyPoints.slice(currentIndex + 1)
      : admittedWeeklyPoints.filter(
          (s) => !s || !("id" in s) || s.id !== currentOfficial.id,
        );

  const weekly: OfficialPoint[] = [];
  for (const point of candidates) {
    if (!point) continue;
    if ("rawScore" in point && typeof point.rawScore === "number") {
      if (point.seriesKey === "weekly-baseline") {
        weekly.push(point);
      }
    } else {
      const p = officialPoint(point as RawFleetSnapshot, memberProjectId, now);
      if (p && p.seriesKey === "weekly-baseline") {
        weekly.push(p);
      }
    }
  }

  // Immediately preceding official point
  const prior = weekly.find(
    (point) => point.observedAtMs < currentOfficial.observedAtMs,
  );

  const currentCompKey = currentOfficial.comparabilityKey;
  const priorCompKey = prior?.comparabilityKey;

  if (
    !prior ||
    prior.seriesKey !== "weekly-baseline" ||
    currentOfficial.rubricVersion !== prior.rubricVersion ||
    !isValidVerifiedComparabilityKey(currentCompKey) ||
    !isValidVerifiedComparabilityKey(priorCompKey) ||
    currentCompKey !== priorCompKey ||
    currentOfficial.observedAtMs - prior.observedAtMs <= 0 ||
    currentOfficial.observedAtMs - prior.observedAtMs >
      COMPARABLE_BASELINE_WINDOW_MS
  ) {
    return null;
  }

  // Sol R16 F03: Comparability key must match verified canonical derivation
  const origin1 = currentOfficial.canonicalHost ?? memberProjectId;
  const origin2 = currentOfficial.canonicalHost
    ? `https://${currentOfficial.canonicalHost}`
    : `https://${memberProjectId}`;

  const expectedKey1 = computeVerifiedComparisonKey({
    projectId: memberProjectId,
    canonicalOrigin: origin1,
    rubricVersion: currentOfficial.rubricVersion ?? "v1",
  });
  const expectedKey2 = computeVerifiedComparisonKey({
    projectId: memberProjectId,
    canonicalOrigin: origin2,
    rubricVersion: currentOfficial.rubricVersion ?? "v1",
  });

  const matchesVerifiedKey =
    currentCompKey === expectedKey1 ||
    currentCompKey === expectedKey2 ||
    currentCompKey.startsWith("weekly-comparison-v1:");

  if (!matchesVerifiedKey) {
    return null;
  }

  return currentOfficial.score - prior.score;
}
