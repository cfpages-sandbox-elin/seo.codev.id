import { describe, expect, it } from "vitest";
import { computeCanonicalRubricV1Score } from "./fleetConstants";
import { computeVerifiedComparisonKey } from "./fleetEvidence";
import { computeTrendDelta, officialPoint } from "./fleetCalculations";

describe("fleet scoring and comparability hardening (V4-03, V4-06)", () => {
  it("computes finite Rubric v1 scores for scientific-notation sub-decimal pillars like 1e-7 (V4-03)", () => {
    const out = computeCanonicalRubricV1Score({
      technical: 1e-7,
      mobilePerf: 80,
      schema: 80,
      onPage: 80,
      ai: 80,
      links: 80,
    });
    expect(Number.isFinite(out.exactScore)).toBe(true);
    expect(out.flooredScore).toBe(52);
    expect(out.grade).toBe("F");

    const tinyAll = computeCanonicalRubricV1Score({
      technical: 1e-7,
      mobilePerf: 1e-7,
      schema: 1e-7,
      onPage: 1e-7,
      ai: 1e-7,
      links: 1e-7,
    });
    expect(tinyAll.exactScore).toBeCloseTo(1e-7, 12);
    expect(tinyAll.flooredScore).toBe(0);
  });

  it("preserves trend delta for valid shared nondefault comparability keys (V4-06)", () => {
    const nowMs = Date.parse("2026-11-26T00:00:00.000Z");
    const nonDefaultKey = computeVerifiedComparisonKey({
      projectId: "proj_1",
      canonicalOrigin: "https://kaca.co.id",
      rubricVersion: "v1",
      panelHash: "custom-panel-v2",
      applicabilityWeightsHash: "weights-custom-1",
      collectorVersion: "2.0.0",
      metricVersion: "1.5.0",
      labProfileHash: "mobile-4g",
      sourceScope: "subdomain",
    });

    const makeRaw = (id: string, score: number, observedAt: string) => {
      const grade: "B" | "C" = score >= 80 ? "B" : "C";
      return {
        id,
        runItemId: `fri_${id}`,
        memberId: "mem_1",
        projectId: "proj_1",
        canonicalHost: "kaca.co.id",
        score,
        grade,
        coverage: 100,
        isProvisional: false,
        provisionalLower: null,
        provisionalUpper: null,
        hasIncidentCap: false,
        incidentReason: null,
        scoreTechnical: score,
        scoreInternalLinks: score,
        scoreMobilePerf: score,
        scoreOnPage: score,
        scoreSchema: score,
        scoreAiReadiness: score,
        seriesKey: "weekly-baseline",
        comparabilityKey: nonDefaultKey,
        evidenceManifestR2Key: null,
        evidenceManifestHash: null,
        observedAt,
        attemptStatus: "completed",
        rubricVersion: "v1",
      };
    };

    const curRaw = makeRaw("cur", 82, "2026-11-25T00:00:00.000Z");
    const prevRaw = makeRaw("prev", 76, "2026-11-18T00:00:00.000Z");
    const curOfficial = officialPoint(curRaw, "proj_1", nowMs);
    expect(curOfficial).not.toBeNull();
    if (!curOfficial) {
      throw new Error("Expected curOfficial to be non-null");
    }

    expect(
      computeTrendDelta(curOfficial, "proj_1", [curRaw, prevRaw], nowMs),
    ).toBe(6);
  });

  it("rejects empty probe objects in incident caps and floors 89.9999999995 pillars without rounding to 90 (Sol R31 V4-01)", () => {
    const nowMs = Date.parse("2026-11-26T00:00:00.000Z");
    const emptyProbeCap = {
      id: "snap_empty_probe",
      runItemId: "fri_empty_probe",
      memberId: "mem_1",
      projectId: "proj_1",
      canonicalHost: "kaca.co.id",
      score: 59,
      grade: "F" as const,
      coverage: 100,
      isProvisional: false,
      provisionalLower: null,
      provisionalUpper: null,
      hasIncidentCap: true,
      incidentReason: JSON.stringify({
        kind: "site_down",
        expectedIntentVerified: true,
        primaryProbe: {},
        corroborationProbe: {},
      }),
      scoreTechnical: 90,
      scoreInternalLinks: 90,
      scoreMobilePerf: 90,
      scoreOnPage: 90,
      scoreSchema: 90,
      scoreAiReadiness: 90,
      seriesKey: "weekly-baseline",
      comparabilityKey: null,
      evidenceManifestR2Key: null,
      evidenceManifestHash: null,
      observedAt: "2026-11-25T00:00:00.000Z",
      attemptStatus: "completed",
      rubricVersion: "v1",
    };
    expect(officialPoint(emptyProbeCap, "proj_1", nowMs)).toBeNull();

    const near90 = {
      ...emptyProbeCap,
      id: "snap_near90",
      hasIncidentCap: false,
      incidentReason: null,
      score: 89,
      grade: "B" as const,
      scoreTechnical: 89.9999999995,
      scoreInternalLinks: 89.9999999995,
      scoreMobilePerf: 89.9999999995,
      scoreOnPage: 89.9999999995,
      scoreSchema: 89.9999999995,
      scoreAiReadiness: 89.9999999995,
    };
    const parsedNear90 = officialPoint(near90, "proj_1", nowMs);
    expect(parsedNear90?.score).toBe(89);
    expect(parsedNear90?.grade).toBe("B");
  });
});
