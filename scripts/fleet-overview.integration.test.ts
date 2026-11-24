import { readFileSync } from "node:fs";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  fleetRosterVersions,
  fleetRosterMembers,
  fleetRuns,
  fleetRunItems,
  fleetSnapshots,
  projects,
} from "@/db/schema";
import { FleetService } from "@/server/features/fleet/services/FleetService";
import { FleetRepository } from "@/server/features/fleet/repositories/FleetRepository";
import { computeVerifiedComparisonKey } from "@/server/features/fleet/services/fleetCalculations";

const stub = vi.hoisted(() => ({ runBatch: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db/runBatch", () => ({ runBatch: stub.runBatch }));
vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  return { db: drizzle(createClient({ url: ":memory:" })) };
});

const { $client: client } = db as unknown as {
  $client: import("@libsql/client").Client;
};
const now = "2026-11-22T12:00:00.000Z";
const baseline = "2026-11-20T09:00:00.000Z";
const earlier = "2026-11-22T08:00:00.000Z";
const later = "2026-11-22 10:00:00";
const host = "fleet-stage1.example";
const laterIso = "2026-11-22T10:00:00.000Z";
const testVerifiedKey = computeVerifiedComparisonKey({
  projectId: "pa",
  canonicalOrigin: host,
});
const changedKey = computeVerifiedComparisonKey({
  projectId: "pa",
  canonicalOrigin: host,
  panelHash: "different-panel",
});
const migration0056 = readFileSync("drizzle/sqlite/0056_modern_zarda.sql", "utf8");
const migration0058 = readFileSync("drizzle/sqlite/0058_typical_riptide.sql", "utf8");

let statements = 0;
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
  if (statements === 0) {
    await client.executeMultiple(
      "PRAGMA foreign_keys=ON; CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id), name TEXT NOT NULL, domain TEXT, location_code INTEGER DEFAULT 2840, language_code TEXT DEFAULT 'en', created_at TEXT DEFAULT CURRENT_TIMESTAMP, archived_at TEXT, ai_research_keywords TEXT); CREATE TABLE audits(id TEXT PRIMARY KEY);",
    );
    await client.executeMultiple(migration0056);
    await client.executeMultiple(migration0058);
  }
  statements++;
  await client.executeMultiple(
    "DELETE FROM fleet_roster_versions; DELETE FROM projects; DELETE FROM organization; INSERT INTO organization VALUES ('a'), ('b');",
  );
  await db.insert(projects).values([
    { id: "pa", organizationId: "a", name: "Project A", domain: host },
    { id: "pb", organizationId: "b", name: "Project B" },
  ]);
  await db.insert(fleetRosterVersions).values([
    {
      id: "va",
      organizationId: "a",
      versionTag: "old",
      approvedAt: "2026-11-19 00:00:00",
      approvedBy: "fixture",
      manifestHash: "a",
    },
    {
      id: "vb",
      organizationId: "b",
      versionTag: "old",
      approvedAt: "2026-11-19 00:00:00",
      approvedBy: "fixture",
      manifestHash: "b",
    },
  ]);
  await db.insert(fleetRosterMembers).values({
    id: "ma",
    versionId: "va",
    canonicalHost: host,
    projectId: "pa",
    category: "Fixture",
  });
});
afterEach(() => vi.restoreAllMocks());

async function attempt(
  id: string,
  status: "completed" | "failed" | "partial",
  at: string,
  options: {
    score?: number;
    coverage?: number;
    errorCode?: string;
    rubric?: string;
    foreignRun?: boolean;
    omitPillars?: boolean;
    omitAiOnly?: boolean;
    pillarScore?: number;
    grade?: "A" | "B" | "C" | "D" | "F" | "ungraded";
    seriesKey?: string;
    comparabilityKey?: string | null;
  } = {},
) {
  await db.insert(fleetRuns).values({
    id,
    organizationId: options.foreignRun ? "b" : "a",
    rosterVersionId: options.foreignRun ? "vb" : "va",
    requesterId: "fixture",
    rubricVersion: options.rubric ?? "v1",
  });
  await db.insert(fleetRunItems).values({
    id,
    runId: id,
    memberId: "ma",
    projectId: "pa",
    status,
    completedAt: at,
    primarySeriesKey: options.seriesKey ?? "weekly-baseline",
    errorCode: options.errorCode,
  });
  if (options.score === undefined) return;
  const { score } = options;
  const pScore = options.pillarScore ?? score;
  const grade: "A" | "B" | "C" | "D" | "F" | "ungraded" =
    options.grade ??
    (score >= 90
      ? "A"
      : score >= 80
        ? "B"
        : score >= 70
          ? "C"
          : score >= 60
            ? "D"
            : "F");

  await db.insert(fleetSnapshots).values({
    id,
    runItemId: id,
    memberId: "ma",
    projectId: "pa",
    canonicalHost: host,
    score,
    grade,
    coverage: options.coverage ?? 100,
    observedAt: at,
    seriesKey: options.seriesKey ?? "weekly-baseline",
    comparabilityKey:
      options.comparabilityKey === undefined
        ? testVerifiedKey
        : options.comparabilityKey,
    ...(options.omitPillars
      ? {}
      : {
          scoreTechnical: pScore,
          scoreInternalLinks: pScore,
          scoreMobilePerf: pScore,
          scoreOnPage: pScore,
          scoreSchema: pScore,
          scoreAiReadiness: options.omitAiOnly ? null : pScore,
        }),
  });
}
async function row() {
  const overview = await FleetService.getOverview("a");
  expect(overview.totalDomains).toBe(1);
  expect(stub.runBatch).not.toHaveBeenCalled();
  return overview.domains[0]!;
}

it.each([undefined, 99])(
  "P1-1 newer partial owns disposition with older failed score %s",
  async (score) => {
    await attempt("good", "completed", baseline, { score: 85 });
    await attempt("failed", "failed", earlier, { score });
    await attempt("partial", "partial", later);
    expect(await row()).toMatchObject({
      status: "fresh_partial",
      score: null,
      lastGoodScore: 85,
      lastGoodObservedAt: baseline,
    });
  },
);

it("P1-1 a partial with a diagnostic code remains partial", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  await attempt("partial", "partial", later, {
    score: 86,
    coverage: 80,
    errorCode: "PILLAR_TIMEOUT",
  });
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    score: null,
    lastGoodScore: 85,
  });
});

it("P1-2 keeps the last official point behind twenty partials", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.parse(earlier) + i * 60_000).toISOString();
    await attempt("partial-" + i, "partial", at, { score: 86, coverage: 80 });
  }
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    score: null,
    lastGoodScore: 85,
    lastGoodObservedAt: baseline,
  });
});

it("P1-2 ranks mixed timestamp forms before selecting newest observation", async () => {
  for (let i = 0; i < 20; i++) {
    const at = new Date(Date.parse(earlier) + i * 60_000).toISOString();
    await attempt("older-" + i, "completed", at, { score: 85 });
  }
  await attempt("latest", "completed", later, { score: 91 });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 91,
    lastGoodObservedAt: laterIso,
    trendDelta: 6,
  });
});

it("P1-3 excludes foreign run lineage from this organization overview", async () => {
  await attempt("local", "completed", baseline, { score: 85 });
  try {
    await attempt("foreign", "completed", later, {
      score: 91,
      foreignRun: true,
    });
  } catch (error) {
    const raw = error instanceof Error ? (error.cause ?? error) : error;
    expect(String(raw)).toMatch(/constraint|foreign key/i);
  }
  expect(await row()).toMatchObject({
    score: 85,
    lastGoodScore: 85,
    trendDelta: null,
  });
});

// Sol Round 11 Stage 1 Regression Oracles (F01, F02, F03, F04)
it("F01 keeps omitted readiness out of the official score and fleet median", async () => {
  await attempt("missing-ai", "completed", later, {
    score: 85,
    omitPillars: true,
  });
  await client.execute(
    "UPDATE fleet_snapshots SET score_technical = 88, score_internal_links = 88, " +
      "score_mobile_perf = 88, score_on_page = 88, score_schema = 88, score_ai_readiness = NULL " +
      "WHERE id = 'missing-ai'",
  );
  expect(await FleetService.getOverview("a")).toMatchObject({
    gradedCount: 0,
    medianScore: null,
    domains: [{ status: "fresh_partial", score: null, scoreAiReadiness: null }],
  });
});

it.each([
  ["same panel", testVerifiedKey, 6],
  ["changed panel, same rubric", changedKey, null],
  ["unverified legacy signature", null, null],
] as const)(
  "F02 uses persisted comparison metadata: %s",
  async (_label, currentKey, expected) => {
    await attempt("weekly-prior", "completed", baseline, {
      score: 85,
      rubric: "v1",
      seriesKey: "weekly-baseline",
      comparabilityKey: testVerifiedKey,
    });
    await attempt("diagnostic", "completed", earlier, {
      score: 95,
      rubric: "v1",
      seriesKey: "diagnostic",
      comparabilityKey: changedKey,
    });
    await attempt("weekly-current", "completed", later, {
      score: 91,
      rubric: "v1",
      seriesKey: "weekly-baseline",
      comparabilityKey: currentKey,
    });
    expect(await row()).toMatchObject({ score: 91, trendDelta: expected });
  },
);

it("F03 keeps newer incomplete evidence visible beside the historical grade", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  await attempt("new-incomplete", "completed", later, {
    score: 85,
    coverage: 95,
    omitAiOnly: true,
  });
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    score: null,
    coverage: 95,
    scoreAiReadiness: null,
    lastGoodScore: 85,
    lastGoodObservedAt: baseline,
    trendDelta: null,
  });
});

it("F03 ignores terminal rows whose completion clock is in the future", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  await attempt("future", "failed", "2026-11-23T00:00:00Z");
  expect(await row()).toMatchObject({ status: "fresh_graded", score: 85 });
});

it.each([
  {
    stored: 95,
    pillar: 30,
    grade: "A",
    status: "fresh_partial",
    expected: null,
  },
  { stored: 30, pillar: 30, grade: "F", status: "fresh_graded", expected: 30 },
  { stored: 0, pillar: 0, grade: "F", status: "fresh_graded", expected: 0 },
] as const)("F04 reconciles $stored against six $pillar pillars", async (c) => {
  await attempt("trial", "completed", later, {
    score: c.stored,
    pillarScore: c.pillar,
    grade: c.grade,
  });
  expect(await row()).toMatchObject({ status: c.status, score: c.expected });
  expect(await FleetService.getOverview("a")).toMatchObject({
    medianScore: c.expected,
    gradedCount: c.expected === null ? 0 : 1,
  });
});

it("F03 ignores a failed attempt for a former project on the same member", async () => {
  await attempt("current", "completed", baseline, { score: 85 });
  await client.execute(
    "INSERT INTO projects(id, organization_id, name) VALUES ('old', 'a', 'Old')",
  );
  await attempt("old", "failed", later);
  await client.execute(
    "UPDATE fleet_run_items SET project_id = 'old' WHERE id = 'old'",
  );
  expect(await row()).toMatchObject({ status: "fresh_graded", score: 85 });
});

it("F03 keeps the newer baseline when an older observation finishes later", async () => {
  await attempt("late", "completed", baseline, { score: 85 });
  await attempt("newer", "completed", earlier, { score: 91 });
  await client.execute({
    sql: "UPDATE fleet_run_items SET completed_at = ? WHERE id = 'late'",
    args: [later],
  });
  expect(await row()).toMatchObject({ status: "fresh_graded", score: 91 });
});

// Sol Round 12 Stage 1 Regression Oracles (P1-1, P1-2, P1-3, P2-1, P2-2)
it("P1-1 rejects 90/A when six 89.9 pillars floor to 89/B", async () => {
  await attempt("invalid-ceiling", "completed", later, {
    score: 90,
    pillarScore: 89.9,
    grade: "A",
  });
  expect(await row()).toMatchObject({ status: "fresh_partial", score: null });
});

it("P1-1 accepts 89/B when six 89.9 pillars floor to 89/B", async () => {
  await attempt("valid-floor", "completed", later, {
    score: 89.9,
    pillarScore: 89.9,
    grade: "B",
  });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 89,
    grade: "B",
  });
});

it("P1-1 rejects 79/B when six 80 pillars calculate to 80/B", async () => {
  await attempt("mismatched-stored", "completed", later, {
    score: 79,
    pillarScore: 80,
    grade: "B",
  });
  expect(await row()).toMatchObject({ status: "fresh_partial", score: null });
});

it("P1-1 rejects unsupported rubric v2 from official baseline", async () => {
  await attempt("unsupported-rubric", "completed", later, {
    score: 85,
    rubric: "v2",
  });
  expect(await row()).toMatchObject({ status: "fresh_partial", score: null });
});

it("P1-2 prevents a newer diagnostic snapshot from replacing the weekly baseline", async () => {
  await attempt("weekly", "completed", baseline, {
    score: 85,
    seriesKey: "weekly-baseline",
  });
  await attempt("diagnostic", "completed", later, {
    score: 95,
    seriesKey: "diagnostic",
  });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 85,
    lastGoodScore: 85,
  });
});

it("P1-2 returns null trend delta when both points have null or empty comparabilityKey", async () => {
  await attempt("prior", "completed", baseline, {
    score: 85,
    seriesKey: "weekly-baseline",
    comparabilityKey: null,
  });
  await attempt("current", "completed", later, {
    score: 91,
    seriesKey: "weekly-baseline",
    comparabilityKey: null,
  });
  expect(await row()).toMatchObject({ score: 91, trendDelta: null });
});

it("P1-3 ignores snapshot when parent attempt completedAt is in the future", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  await attempt("future-item", "completed", "2026-11-23T12:00:00.000Z", {
    score: 95,
  });
  await client.execute({
    sql: "UPDATE fleet_snapshots SET observed_at = ? WHERE id = 'future-item'",
    args: [later],
  });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 85,
    lastGoodScore: 85,
  });
});

it("P1-3 ignores snapshot when observation time is in the future", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  await attempt("future-obs", "completed", later, { score: 95 });
  await client.execute({
    sql: "UPDATE fleet_snapshots SET observed_at = '2026-11-23T12:00:00.000Z' WHERE id = 'future-obs'",
  });
  expect(await row()).toMatchObject({
    status: "unavailable",
    score: null,
    lastGoodScore: 85,
    lastGoodObservedAt: baseline,
  });
});

it("P1-3 snapshot-less partial does not borrow prior snapshot coverage or pillars", async () => {
  await attempt("good", "completed", baseline, { score: 85, coverage: 100 });
  await attempt("partial-no-snap", "partial", later);
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    score: null,
    coverage: null,
    scoreTechnical: null,
    lastGoodScore: 85,
    lastGoodObservedAt: baseline,
  });
});

it("P1-3 stale row does not emit headline trend delta", async () => {
  const staleDate = "2026-11-01T00:00:00.000Z";
  const olderStaleDate = "2026-10-25T00:00:00.000Z";
  await attempt("stale-prior", "completed", olderStaleDate, { score: 80 });
  await attempt("stale-current", "completed", staleDate, { score: 86 });
  expect(await row()).toMatchObject({
    status: "stale",
    score: null,
    trendDelta: null,
    lastGoodScore: 86,
  });
});

it("P2-2 distinguishes measured 0% coverage from missing coverage", async () => {
  await attempt("zero-cov", "completed", later, {
    score: 30,
    pillarScore: 30,
    coverage: 0,
    grade: "F",
  });
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    coverage: 0,
  });
});

it("P2-2 only counts current flags in criticalIncidentsCount", async () => {
  const staleDate = "2026-11-01T00:00:00.000Z";
  await attempt("stale-cap", "completed", staleDate, { score: 50, grade: "F" });
  await client.execute(
    "UPDATE fleet_snapshots SET has_incident_cap = 1 WHERE id = 'stale-cap'",
  );
  const overview = await FleetService.getOverview("a");
  expect(overview.criticalIncidentsCount).toBe(0);
});

it("keeps weekly grade and suppresses an unverified trend (F01)", async () => {
  await attempt("old-key", "completed", baseline, {
    score: 80,
    comparabilityKey: "*",
  });
  await attempt("new-key", "completed", later, {
    score: 84,
    comparabilityKey: "*",
  });
  expect(await row()).toMatchObject({ score: 84, trendDelta: null });
});

it("leaves a valid weekly headline intact after a diagnostic partial (F02)", async () => {
  await attempt("good-weekly", "completed", baseline, { score: 85 });
  await attempt("diag-partial", "partial", later, {
    score: 65,
    coverage: 60,
    seriesKey: "diagnostic",
  });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 85,
    coverage: 100,
  });
});

it("keeps 89/B after persisting pillars just below 90 (F03)", async () => {
  await attempt("near-90", "completed", later, {
    score: 89,
    grade: "B",
    pillarScore: 89.999999,
  });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 89,
    grade: "B",
  });
});

it("does not treat a bare partial cap flag as confirmed (F05)", async () => {
  await attempt("incomplete-flag", "partial", later, {
    score: 59,
    coverage: 0,
    omitPillars: true,
  });
  await client.execute(
    "UPDATE fleet_snapshots SET has_incident_cap = 1 WHERE id = 'incomplete-flag'",
  );
  expect(await FleetService.getOverview("a")).toMatchObject({
    criticalIncidentsCount: 0,
    domains: [{ score: null, hasIncidentCap: false }],
  });
});

it("rejects out-of-range percentage measurements with null (F06)", async () => {
  await attempt("invalid-cov-pillar", "partial", later, {
    score: 50,
    coverage: 101,
    pillarScore: -1,
  });
  expect(await row()).toMatchObject({
    coverage: null,
    scoreTechnical: null,
  });
});

it("excludes members with enrollmentState === 'excluded' from denominators (F10)", async () => {
  await db.insert(fleetRosterMembers).values({
    id: "m-excluded",
    versionId: "va",
    canonicalHost: "excluded.example",
    projectId: null,
    category: "Other",
    categoryEmoji: "📦",
    tier: "Tier 3",
    siteIntent: "commercial",
    platform: "wordpress_static",
    enrollmentState: "excluded",
    aliasesJson: "[]",
  });
  const overview = await FleetService.getOverview("a");
  expect(overview.totalDomains).toBe(1);
});

it("F01: keeps partial envelopes out of official history and preserves last-good 85 and +5 trend", async () => {
  // Step 1: completed 85 at baseline
  await attempt("c85", "completed", baseline, { score: 85, grade: "B" });
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 85,
    lastGoodScore: 85,
  });

  // Step 2: partial 99 at earlier (weekly baseline partial)
  await attempt("p99", "partial", earlier, {
    score: 99,
    coverage: 85,
  });
  // Last good score must remain 85, NOT 99!
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    score: null,
    lastGoodScore: 85,
  });

  // Step 3: completed 90 arrives at later
  await attempt("c90", "completed", later, { score: 90, grade: "A" });
  // Trend delta must be 90 - 85 = +5 (NOT 90 - 99 = -9!)
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 90,
    lastGoodScore: 90,
    trendDelta: 5,
  });
});

it("F02: diagnostic-only attempts do not corrupt weekly baseline disposition or score", async () => {
  await attempt("diag-fail", "failed", later, {
    seriesKey: "diagnostic",
    errorCode: "dns_nxdomain",
  });
  expect(await row()).toMatchObject({
    status: "never_audited",
    score: null,
  });
});

it("F04: reconciles Sol golden pillars [20.23, 86.71, 44.57, 51.44, 26.44, 22.09] to exact 38/F", async () => {
  await attempt("golden-38", "completed", later, {
    score: 38,
    grade: "F",
  });
  await client.execute(`
    UPDATE fleet_snapshots
    SET score_technical = 20.23,
        score_mobile_perf = 86.71,
        score_schema = 44.57,
        score_on_page = 51.44,
        score_ai_readiness = 26.44,
        score_internal_links = 22.09
    WHERE id = 'golden-38'
  `);
  expect(await row()).toMatchObject({
    status: "fresh_graded",
    score: 38,
    grade: "F",
  });
});

it("F05: computes provisional interval [73, 88] at 85% coverage and rejects invalid persisted [-5, 200]", async () => {
  await attempt("prov-85", "partial", later, {
    score: 73,
    coverage: 85,
    pillarScore: 73,
  });
  // Inject invalid persisted endpoints [-5, 200]
  await client.execute(`
    UPDATE fleet_snapshots
    SET provisional_lower = -5, provisional_upper = 200
    WHERE id = 'prov-85'
  `);
  // Overview must reject [-5, 200] and return valid derived interval [73, 88]
  expect(await row()).toMatchObject({
    status: "fresh_partial",
    provisionalRange: { lower: 73, upper: 88 },
  });
});

it("F06: preserves historical incident cap for 11-day-old point", async () => {
  const elevenDaysAgo = "2026-11-09T00:00:00.000Z";
  const reasonJson = JSON.stringify({
    kind: "dns_nxdomain",
    expectedIntentVerified: true,
    primaryProbe: { probeId: "probe-1", source: "synthetic-edge" },
    corroborationProbe: { probeId: "probe-2", source: "external-monitor" },
    confirmedAt: "2026-11-08T23:50:00.000Z",
  });
  await attempt("old-cap", "completed", elevenDaysAgo, {
    score: 59,
    grade: "F",
  });
  await client.execute(`
    UPDATE fleet_snapshots
    SET has_incident_cap = 1,
        incident_reason = '${reasonJson}'
    WHERE id = 'old-cap'
  `);
  // Historical 11-day-old point must still reconcile as official point with 59/F
  expect(await row()).toMatchObject({
    lastGoodScore: 59,
  });
});

it("F08: getApprovedRoster ignores future approvals and picks effective approved version", async () => {
  const futureDate = "2026-11-30T00:00:00.000Z";
  await db.insert(fleetRosterVersions).values({
    id: "v-future",
    organizationId: "a",
    versionTag: "v2.0-future",
    domainCount: 0,
    manifestHash: "future-hash",
    approvedBy: "Future Tester",
    approvedAt: futureDate,
  });
  const effective = await FleetRepository.getApprovedRoster("a");
  expect(effective?.id).toBe("va");
});

it("F01: keeps a different host's observation out of the approved row", async () => {
  await db.update(projects).set({ domain: host });
  await attempt("other-host", "completed", baseline, { score: 95 });
  await client.execute(
    "UPDATE fleet_snapshots SET canonical_host = 'different.example' WHERE id = 'other-host'",
  );

  expect(await row()).toMatchObject({
    canonicalHost: host,
    projectId: "pa",
    score: null,
    lastGoodScore: null,
  });
});

it("F01: invalidates a mapping when the linked project moves", async () => {
  await db.update(projects).set({ domain: host });
  await attempt("same-host", "completed", baseline, { score: 85 });
  await db.update(projects).set({ domain: "different.example" });

  expect(await row()).toMatchObject({
    canonicalHost: host,
    projectId: null,
    status: "unmapped",
    score: null,
  });
});

it("F02: keeps partial coverage visible without inventing an interval", async () => {
  await attempt("missing-rule-mass", "partial", baseline, {
    score: 100,
    coverage: 85,
  });

  expect(await row()).toMatchObject({
    status: "fresh_partial",
    coverage: 85,
    score: null,
    provisionalRange: null,
  });
});

it("F03: does not publish a cap or flag based on an undated legacy token", async () => {
  await attempt("legacy-cap", "completed", later, {
    score: 59,
    pillarScore: 90,
  });
  await client.execute(`
    UPDATE fleet_snapshots
    SET has_incident_cap = 1,
        incident_reason = 'confirmed:site_down:probe-a:probe-b:corroborated'
    WHERE id = 'legacy-cap'
  `);

  expect(await FleetService.getOverview("a")).toMatchObject({
    criticalIncidentsCount: 0,
    domains: [{ score: null, grade: "ungraded", hasIncidentCap: false }],
  });
});

it("F04: does not compare official points that share only a placeholder token", async () => {
  const comparabilityKey = "weekly-comparison-v1:placeholder";
  await attempt("prior", "completed", baseline, {
    score: 80,
    comparabilityKey,
  });
  await attempt("next", "completed", later, {
    score: 84,
    comparabilityKey,
  });

  expect(await row()).toMatchObject({
    score: 84,
    grade: "B",
    trendDelta: null,
  });
});

it("F08: does not promote 89.999999996 across the grade boundary to 90/A", async () => {
  await attempt("below-a", "completed", baseline, {
    score: 89,
    pillarScore: 89.999999996,
  });
  expect(await row()).toMatchObject({ score: 89, grade: "B" });
});

it("F01: keeps completed attempt without observation unavailable while preserving last good", async () => {
  await attempt("prior", "completed", baseline, { score: 85 });
  await attempt("snapshotless", "completed", later);
  expect(await row()).toMatchObject({
    status: "unavailable",
    score: null,
    lastGoodScore: 85,
    lastGoodObservedAt: baseline,
  });
});

it("F02: rejects security_challenge and undated corroborator from incident cap", async () => {
  await attempt("undated-corr", "completed", later, {
    score: 59,
    pillarScore: 90,
  });
  await client.execute(`
    UPDATE fleet_snapshots
    SET has_incident_cap = 1,
        incident_reason = '{"kind":"security_challenge","expectedIntentVerified":true,"primaryProbe":{"id":"p1","source":"edge","confirmedAtMs":1763800000000},"corroborationProbe":{"id":"p2","source":"monitor"}}'
    WHERE id = 'undated-corr'
  `);
  expect(await row()).toMatchObject({ score: null, grade: "ungraded" });
});
