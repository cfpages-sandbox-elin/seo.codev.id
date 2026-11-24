import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  officialPoint,
  gradeFor,
  deriveDisposition,
  computeTrendDelta,
  calculateMedian,
  parseUtcTimestampMs,
  computeVerifiedComparisonKey,
  computeCanonicalRubricV1Score,
  FRESHNESS_WINDOW_MS,
  COMPARABLE_BASELINE_WINDOW_MS,
} from "./fleetCalculations";
import type { SnapshotAttemptOverlay } from "./FleetService";
import type {
  RawFleetMember,
  RawFleetSnapshot,
} from "../repositories/FleetRepository";

const nowMs = new Date("2026-11-22T12:00:00.000Z").getTime();

const testVerifiedKey = computeVerifiedComparisonKey({
  projectId: "proj-1",
  canonicalOrigin: "tukang.co.id",
});

const sampleMember: RawFleetMember = {
  id: "mem-1",
  versionId: "ver-1",
  canonicalHost: "tukang.co.id",
  projectId: "proj-1",
  category: "Home & Property",
  categoryEmoji: "🔨",
  tier: "Tier 1",
  siteIntent: "commercial",
  platform: "wordpress_static",
  repoName: "tukang-co-id",
  publishRoot: ".",
  enrollmentState: "active",
  aliasesJson: "[]",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const sampleSnap: RawFleetSnapshot & {
  comparabilityKey?: string;
  attemptStatus?: string;
} = {
  id: "snap-1",
  runItemId: "run-item-1",
  memberId: "mem-1",
  projectId: "proj-1",
  canonicalHost: "tukang.co.id",
  score: 85,
  grade: "B",
  coverage: 100,
  isProvisional: false,
  provisionalLower: null,
  provisionalUpper: null,
  hasIncidentCap: false,
  incidentReason: null,
  scoreTechnical: 85,
  scoreInternalLinks: 85,
  scoreMobilePerf: 85,
  scoreOnPage: 85,
  scoreSchema: 85,
  scoreAiReadiness: 85,
  evidenceManifestR2Key: null,
  evidenceManifestHash: null,
  observedAt: "2026-11-20T12:00:00.000Z",
  attemptStatus: "completed",
  comparabilityKey: testVerifiedKey,
  seriesKey: "weekly-baseline",
};

describe("FleetService domain invariants", () => {
  it("computes correct letter grade boundaries", () => {
    expect(gradeFor(100)).toBe("A");
    expect(gradeFor(90)).toBe("A");
    expect(gradeFor(89.9)).toBe("B");
    expect(gradeFor(80)).toBe("B");
    expect(gradeFor(79.9)).toBe("C");
    expect(gradeFor(70)).toBe("C");
    expect(gradeFor(69.9)).toBe("D");
    expect(gradeFor(60)).toBe("D");
    expect(gradeFor(59.9)).toBe("F");
    expect(gradeFor(0)).toBe("F");
  });

  it("F03: exact rational arithmetic computes 90/A for near-boundary rational tuple", () => {
    expect(
      computeCanonicalRubricV1Score({
        technical: 99.88,
        mobilePerf: 91.5,
        schema: 80.39,
        onPage: 97.0,
        ai: 68.0,
        links: 76.64,
      }),
    ).toMatchObject({ exactScore: 90, flooredScore: 90, grade: "A" });
  });

  it("resolves official point for valid 100% coverage, completed snapshot", () => {
    const point = officialPoint(sampleSnap, "proj-1", nowMs);
    expect(point).not.toBeNull();
    expect(point?.score).toBe(85);
    expect(point?.grade).toBe("B");
  });

  it("rejects provisional, partial, or out-of-bounds snapshots from official point", () => {
    // Coverage < 100 (partial)
    expect(
      officialPoint({ ...sampleSnap, coverage: 85 }, "proj-1", nowMs),
    ).toBeNull();

    // Coverage > 100 (invalid)
    expect(
      officialPoint({ ...sampleSnap, coverage: 101 }, "proj-1", nowMs),
    ).toBeNull();

    // Provisional
    expect(
      officialPoint({ ...sampleSnap, isProvisional: true }, "proj-1", nowMs),
    ).toBeNull();

    // Score out of range (> 100)
    expect(
      officialPoint({ ...sampleSnap, score: 130 }, "proj-1", nowMs),
    ).toBeNull();

    // Stored grade mismatch ("ungraded" when score is 85)
    expect(
      officialPoint({ ...sampleSnap, grade: "ungraded" }, "proj-1", nowMs),
    ).toBeNull();

    // Future timestamp
    expect(
      officialPoint(
        { ...sampleSnap, observedAt: "2026-11-25T12:00:00.000Z" },
        "proj-1",
        nowMs,
      ),
    ).toBeNull();

    // Different project ID
    expect(officialPoint(sampleSnap, "proj-different", nowMs)).toBeNull();

    // Incident cap violation (has incident cap but score > 59)
    expect(
      officialPoint(
        { ...sampleSnap, hasIncidentCap: true, score: 85 },
        "proj-1",
        nowMs,
      ),
    ).toBeNull();
  });

  it("enforces strict 7-disposition precedence adhering to PRD §2", () => {
    // 1. Unmapped has precedence even over exempt (Sol PV-3)
    const unmappedExempt: RawFleetMember = {
      ...sampleMember,
      projectId: null,
      enrollmentState: "exempt",
    };
    expect(deriveDisposition(unmappedExempt, sampleSnap, nowMs)).toBe(
      "unmapped",
    );

    // 2. Exempt when mapped
    const exemptMember: RawFleetMember = {
      ...sampleMember,
      enrollmentState: "exempt",
    };
    expect(deriveDisposition(exemptMember, sampleSnap, nowMs)).toBe("exempt");

    // 3. Never audited when no snapshot exists
    expect(deriveDisposition(sampleMember, null, nowMs)).toBe("never_audited");

    // 4. Unavailable when latest attempt failed
    const failedSnap: SnapshotAttemptOverlay = {
      ...sampleSnap,
      status: "failed",
    };
    expect(deriveDisposition(sampleMember, failedSnap, nowMs)).toBe(
      "unavailable",
    );

    // 5. Stale when older than 10 days
    const staleSnap: RawFleetSnapshot = {
      ...sampleSnap,
      observedAt: new Date(nowMs - 11 * 86_400_000).toISOString(),
    };
    expect(deriveDisposition(sampleMember, staleSnap, nowMs)).toBe("stale");

    // 6. Fresh partial when <= 10 days but coverage < 100
    const partialSnap: RawFleetSnapshot = {
      ...sampleSnap,
      coverage: 80,
      observedAt: new Date(nowMs - 2 * 86_400_000).toISOString(),
    };
    expect(deriveDisposition(sampleMember, partialSnap, nowMs)).toBe(
      "fresh_partial",
    );

    // 7. Fresh graded when <= 10 days and 100% coverage
    const freshGradedSnap: RawFleetSnapshot = {
      ...sampleSnap,
      coverage: 100,
      observedAt: new Date(nowMs - 2 * 86_400_000).toISOString(),
    };
    expect(deriveDisposition(sampleMember, freshGradedSnap, nowMs)).toBe(
      "fresh_graded",
    );
  });
});

describe("FleetService trend, median, and Sol regression fixtures", () => {
  it("computes trend delta across intervening partial snapshots within 21 days", () => {
    const current = officialPoint(
      {
        ...sampleSnap,
        score: 90,
        grade: "A",
        scoreTechnical: 90,
        scoreInternalLinks: 90,
        scoreMobilePerf: 90,
        scoreOnPage: 90,
        scoreSchema: 90,
        scoreAiReadiness: 90,
        observedAt: new Date(nowMs - 1 * 86_400_000).toISOString(),
      },
      "proj-1",
      nowMs,
    );

    // Preceding partial snapshot (should be skipped)
    const partialSnap: RawFleetSnapshot = {
      ...sampleSnap,
      id: "snap-partial",
      score: 75,
      grade: "C",
      coverage: 60,
      isProvisional: true,
      observedAt: new Date(nowMs - 5 * 86_400_000).toISOString(),
    };

    // Preceding official baseline snapshot
    const baselineSnap: RawFleetSnapshot = {
      ...sampleSnap,
      id: "snap-baseline",
      score: 85,
      grade: "B",
      coverage: 100,
      observedAt: new Date(nowMs - 15 * 86_400_000).toISOString(),
    };

    const delta = computeTrendDelta(
      current,
      "proj-1",
      [sampleSnap, partialSnap, baselineSnap],
      nowMs,
    );

    expect(delta).toBe(5); // 90 - 85 = +5

    // Over 21 days gap returns null
    const oldBaselineSnap: RawFleetSnapshot = {
      ...baselineSnap,
      observedAt: new Date(nowMs - 25 * 86_400_000).toISOString(),
    };
    const expiredDelta = computeTrendDelta(
      current,
      "proj-1",
      [sampleSnap, partialSnap, oldBaselineSnap],
      nowMs,
    );
    expect(expiredDelta).toBeNull();

    // Incompatible comparabilityKey returns null (Sol PV-2)
    const incompatibleBaselineSnap: SnapshotAttemptOverlay = {
      ...baselineSnap,
      id: "snap-incompatible",
      comparabilityKey: testVerifiedKey.slice(0, -1) + "0",
    };
    const incompatibleDelta = computeTrendDelta(
      current,
      "proj-1",
      [sampleSnap, partialSnap, incompatibleBaselineSnap],
      nowMs,
    );
    expect(incompatibleDelta).toBeNull();
  });

  it("normalizes SQLite space-delimited timestamps to exact UTC milliseconds", () => {
    const sqliteTimestamp = "2026-11-20 12:00:00";
    const isoTimestamp = "2026-11-20T12:00:00.000Z";
    expect(parseUtcTimestampMs(sqliteTimestamp)).toBe(
      parseUtcTimestampMs(isoTimestamp),
    );
    expect(parseUtcTimestampMs("invalid-timestamp")).toBeNaN();
    expect(parseUtcTimestampMs(null)).toBeNaN();
  });

  it("returns never_audited when latest snapshot belongs to a different project", () => {
    const diffProjectSnap: RawFleetSnapshot = {
      ...sampleSnap,
      projectId: "proj-old-legacy",
    };
    expect(deriveDisposition(sampleMember, diffProjectSnap, nowMs)).toBe(
      "never_audited",
    );
  });

  it("returns unavailable when latest terminal attempt failed even if snapshot is present", () => {
    const failedAttempt = { status: "failed", errorCode: "CRAWL_TIMEOUT" };
    expect(
      deriveDisposition(sampleMember, sampleSnap, nowMs, failedAttempt),
    ).toBe("unavailable");
  });

  it("rejects snapshot from official point when any of the six pillars is null or out-of-bounds", () => {
    const missingPillarSnap = { ...sampleSnap };
    missingPillarSnap.scoreTechnical = null;
    expect(officialPoint(missingPillarSnap, "proj-1", nowMs)).toBeNull();

    // Out-of-bounds pillar score (> 100)
    expect(
      officialPoint({ ...sampleSnap, scoreMobilePerf: 110 }, "proj-1", nowMs),
    ).toBeNull();
  });

  it("calculates median score accurately for odd, even, and empty distributions", () => {
    expect(calculateMedian([])).toBeNull();
    expect(calculateMedian([85])).toBe(85);
    expect(calculateMedian([80, 90])).toBe(85);
    expect(calculateMedian([70, 80, 90])).toBe(80);
    expect(calculateMedian([60, 70, 80, 90])).toBe(75);
  });

  it("verifies 10-day freshness and 21-day trend comparison window constants", () => {
    expect(FRESHNESS_WINDOW_MS).toBe(10 * 86_400_000);
    expect(COMPARABLE_BASELINE_WINDOW_MS).toBe(21 * 86_400_000);
  });

  // Sol Round 8 P1 fixture regressions
  it("rejects trend delta when rubric versions (comparability keys) differ (P1-1)", () => {
    const currentPoint = officialPoint(
      {
        ...sampleSnap,
        id: "snap-v2",
        score: 90,
        grade: "A" as const,
        observedAt: "2026-11-21T12:00:00.000Z",
        comparabilityKey: testVerifiedKey.slice(0, -1) + "0",
      },
      "proj-1",
      nowMs,
    );
    const priorSnap = {
      ...sampleSnap,
      id: "snap-v1",
      score: 85,
      grade: "B" as const,
      observedAt: "2026-11-19T12:00:00.000Z",
      comparabilityKey: testVerifiedKey,
    };
    expect(
      computeTrendDelta(currentPoint, "proj-1", [sampleSnap, priorSnap], nowMs),
    ).toBeNull();
  });

  it("skips failed attempt snapshots when computing trend baseline delta (P1-1)", () => {
    const currentSnap = {
      ...sampleSnap,
      id: "snap-3",
      score: 90,
      grade: "A" as const,
      scoreTechnical: 90,
      scoreInternalLinks: 90,
      scoreMobilePerf: 90,
      scoreOnPage: 90,
      scoreSchema: 90,
      scoreAiReadiness: 90,
      observedAt: "2026-11-21T12:00:00.000Z",
      attemptStatus: "completed",
      comparabilityKey: testVerifiedKey,
    };
    const currentPoint = officialPoint(currentSnap, "proj-1", nowMs);
    const failedIntermediateSnap = {
      ...sampleSnap,
      id: "snap-2",
      score: 99,
      grade: "A" as const,
      observedAt: "2026-11-19T12:00:00.000Z",
      attemptStatus: "failed",
      comparabilityKey: testVerifiedKey,
    };
    const validPriorSnap = {
      ...sampleSnap,
      id: "snap-1",
      score: 80,
      grade: "B" as const,
      scoreTechnical: 80,
      scoreInternalLinks: 80,
      scoreMobilePerf: 80,
      scoreOnPage: 80,
      scoreSchema: 80,
      scoreAiReadiness: 80,
      observedAt: "2026-11-18T12:00:00.000Z",
      attemptStatus: "completed",
      comparabilityKey: testVerifiedKey,
    };
    const delta = computeTrendDelta(
      currentPoint,
      "proj-1",
      [currentSnap, failedIntermediateSnap, validPriorSnap],
      nowMs,
    );
    expect(delta).toBe(10); // 90 - 80, skipping failed 99
  });

  it("rejects official point and returns fresh_partial when all pillars are zero while score > 0 (P1-3)", () => {
    const omittedPillarsSnap = {
      ...sampleSnap,
      score: 85,
      grade: "B" as const,
      coverage: 100,
      scoreTechnical: 0,
      scoreInternalLinks: 0,
      scoreMobilePerf: 0,
      scoreOnPage: 0,
      scoreSchema: 0,
      scoreAiReadiness: 0,
    };
    expect(officialPoint(omittedPillarsSnap, "proj-1", nowMs)).toBeNull();
    expect(
      deriveDisposition(sampleMember, omittedPillarsSnap, nowMs, {
        status: "completed",
      }),
    ).toBe("fresh_partial");
  });

  it("resolves fresh_partial when latest terminal attempt is partial even if older attempt failed (P1-2)", () => {
    const partialAttempt = { status: "partial", errorCode: null };
    const partialSnap = {
      ...sampleSnap,
      coverage: 60,
      isProvisional: false,
      score: 0,
      grade: "ungraded" as const,
    };
    expect(
      deriveDisposition(sampleMember, partialSnap, nowMs, partialAttempt),
    ).toBe("fresh_partial");
  });
});
