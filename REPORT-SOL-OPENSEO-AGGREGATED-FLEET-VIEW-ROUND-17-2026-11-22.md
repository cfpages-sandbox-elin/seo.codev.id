# OpenSEO Aggregated Fleet View · Stage 1 review · Round 17

**Engineer Sol · 22 November 2026 (Asia/Jakarta) · Gate failed · 5.91 / 10.00**

Reviewed the current local `/onsite` implementation, including uncommitted fleet source and both fleet migrations, on base `0512c7423284a58283723a61cdea57b5b36b485e`. The acceptance baseline is the [OpenSEO Aggregated Fleet View PRD](C:/Users/THINKPAD/OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md) and [DESIGN.md](./DESIGN.md). Previous review reports were excluded from the assessment. `DESIGN.md` defines a private read-only preview. The PRD also defines a scored pilot and fleet launch. The review identifies missing launch code separately from defects in the preview, and the preview defects alone prevent Stage 1 certification. Live Google SSO, deployed bindings, live screenshots, production migrations, and edge performance carry zero weight here.

The implementation has a clear TanStack server function → service → repository path. The RPC checks the active organization, an explicit feature flag and organization allowlist, and a role grant. The matrix uses a native table, visible status labels, a keyboard-focusable scroll region, and labelled audit links. All five focused suites passed. The central issue is evidence integrity. A completed row can enter the official fleet median and report a trend without rule results or a real sampling identity. Fractional intervals also change across storage engines. Seven P1 findings remain open. No P0 was established.

## Scores and the path to 8.0

An 8.0 requires the core behavior in each vector to satisfy the reviewed source contract with repeatable local evidence. P1 means a defect or missing core implementation blocks reliable Stage 1 acceptance. P2 identifies bounded defects and coverage gaps. Weighted contributions below use the specified weights without intermediate rounding.

| Vector                                 |   Weight |            Score | Contribution | What prevents 8.0 and the required proof                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------: | ---------------: | -----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and contract soundness    |      20% |              5.5 |        1.100 | No evidence-to-snapshot producer, no durable evaluation/admission path, no fixed-checkpoint query, and no end-to-end pilot. Implement the narrow vertical slice in F01, F02, and F07. An admitted fixture audit must yield the same explainable published point after retry and replay.                                                                              |
| Persistence and dual-dialect parity    |      20% |              5.7 |        1.140 | Both journals apply, but matching declarations still accept inconsistent lineage and store different fractional values. The import is D1-only. Implement F03, F05, and F06. The same migration and repository tests must give identical results for both engines, including negative constraints and replay.                                                         |
| Edge cases and numerical robustness    |      25% |              4.7 |        1.175 | Valid boundaries are undergraded, provisional mass is inferred, trend provenance is inverted, and cap validity can diverge from the displayed interval. Implement F01–F04 and F08. Exact rational oracles must pass at and below every grade boundary, with method drift and missing evidence carried through the real read path.                                    |
| Security and authorization             |      15% |              7.5 |        1.125 | The RPC fails closed in source. Tenant lineage is only partially enforced, approval authority and assignment are outside the verified payload, and the component can prefer old loader data over current workspace state. Implement F05, F06, and F09. Exercise the actual server middleware and show that previous-workspace data clears on revalidation or denial. |
| Accessibility and design contract      |      10% |              6.8 |        0.680 | Core table semantics are present. Keyboard focus can be lost on reset, individual cells lack a domain row header, and overview/empty/error content falls short of the contract. Implement F08, F09, and F10. Verify from the local component entry point with keyboard, rendered markup, narrow viewport, and state fixtures.                                        |
| Code quality, strict typing, and tests |      10% |              6.9 |        0.690 | Both TypeScript checks pass, and focused tests cover useful SQLite cases. Fleet exports fail Knip, two changed files fail normalized formatting, and tests miss the real authorization stack, rule evidence, and PostgreSQL value behavior. Implement F03, F05, F09–F11 and rerun the named checks.                                                                  |
| **Composite**                          | **100%** | **5.91 / 10.00** |    **5.910** | Gate requires composite ≥ 8.0, every vector ≥ 8.0, and zero P0/P1.                                                                                                                                                                                                                                                                                                   |

## P1 findings

### F01 · Grade admission accepts summary rows without rule evidence

**Confirmed on the local scoring path.** The repository returns snapshot totals and optional evidence pointers. It never reads `fleet_rule_results`. `officialPoint` accepts `coverage = 100`, valid-looking six pillar totals, a completed parent, and a matching score/letter. The snapshot schema defaults coverage to 100 and makes both evidence fields nullable. No production source writes fleet snapshots or rule results. Two fixture points containing zero rule rows and null evidence fields were admitted as 80/B and 90/A, with the latest point entering the median. The current read path proves arithmetic reconciliation of a claimed summary. PRD §3 and F02 require replayable evidence from the planned applicable population. [FleetRepository.ts:179](./src/server/features/fleet/repositories/FleetRepository.ts#L179) · [fleetCalculations.ts:199](./src/server/features/fleet/services/fleetCalculations.ts#L199) · [fleet.schema.ts:203](./src/db/fleet.schema.ts#L203)

1. In `src/server/features/fleet/services/`, add a versioned rule registry and a pure `evaluatePanel` function. Freeze planned unit IDs, applicable rules and prerequisites in the panel. Treat an absent unit, corrupt result, duplicate unit, failed prerequisite, or expired carry-forward as unknown. Require an observed core population in every pillar. Permit half-credit only for the declared lab rules.
2. Compute the verified result from the registry and plan. In each pillar, normalize rule weights over the declared applicable rules. Keep all six pillar weights fixed. Persist exact mass and coverage with evidence digest and rule results in F07's publication transaction. Drop default `100` coverage. Allow `score` to be null for an ungraded point. Quarantine summary-only historical rows or serve their verified observations as diagnostics after replay.
3. Expose coverage, missing mass, missing rule IDs, evidence time and per-rule contributions from the same verified result. Keep the overview projection bounded by storing only a projection whose integrity is guaranteed at publication. Regression-test the read path against a raw summary-only row.

```ts
type UnitCredit = 0 | 1 | 2; // half-credit units

function readRule(rule: PlannedRule, byUnit: Map<string, UnitResult>) {
  if (!rule.prerequisitesMet || rule.applicableUnitIds.length === 0)
    return null;
  let earned = 0;
  for (const id of rule.applicableUnitIds) {
    const result = byUnit.get(id);
    if (!result || result.status !== "observed") return null;
    const credit: UnitCredit = result.creditInHalves;
    if (credit === 1 && !rule.allowsHalfCredit) return null;
    earned += credit;
  }
  return fraction(BigInt(earned), BigInt(2 * rule.applicableUnitIds.length));
}
```

Use the existing `attempt` and `row` helpers in `scripts/fleet-overview.integration.test.ts` for the negative control. Update positive fixtures to publish rule evidence. The same fixture must run on both engines.

```ts
it("keeps a summary without a published rule envelope ungraded", async () => {
  await attempt("summary-only", "completed", laterIso, { score: 95 });
  expect(await row()).toMatchObject({ score: null, grade: "ungraded" });
  expect((await FleetService.getOverview("a")).gradedCount).toBe(0);
});
```

### F02 · Comparison admits default provenance and rejects real method identity

**Confirmed by independent executable probe.** `computeVerifiedComparisonKey` defaults missing method fields to placeholder values and hashes the resulting tuple. `computeTrendDelta` only regenerates keys from the project, host, and rubric. The 64-hex guard makes its `weekly-comparison-v1:` alternative unreachable. A shared default hash produced `+10` for 80 → 90 with no method lineage. Replacing it with a shared key computed using an explicit panel, weights, collector, metric, lab profile, and source scope suppressed the delta. The service also returns only a number or null, so the UI cannot explain divergence or a time gap. PRD §4 and F03 require the immediately preceding graded point, a complete method identity, and an explicit mismatch reason. [fleetEvidence.ts:200](./src/server/features/fleet/services/fleetEvidence.ts#L200) · [fleetCalculations.ts:418](./src/server/features/fleet/services/fleetCalculations.ts#L418)

1. Persist the complete identity as validated immutable columns or a reference to a method record. Require normalized `canonicalOrigin`, `seriesKey`, stable property/project IDs, rubric, panel and applicability hashes, collector and metric versions, lab profile, and source scope. Include the device, region, and engine major in the lab profile. Bind derived hashes to a validated envelope and remove all defaults.
2. Select the immediately preceding graded point in this series by observation time. If it differs in any field, return that field as the reason. Mark missing provenance and gaps beyond 21 days explicitly. Keep diagnostic and targeted series separate. Expose displayed delta, exact delta, and the contribution from any cap change.

```ts
const comparisonFields = [
  "propertyId",
  "projectId",
  "canonicalOrigin",
  "seriesKey",
  "rubricVersion",
  "panelHash",
  "applicabilityWeightsHash",
  "collectorVersion",
  "metricVersion",
  "labProfileHash",
  "sourceScope",
] as const satisfies readonly (keyof PublishedMethod)[];

function compareWeekly(
  current: PublishedPoint,
  prior: PublishedPoint | undefined,
) {
  if (!prior) return { kind: "no_prior" } as const;
  if (!current.method || !prior.method)
    return { kind: "missing_method" } as const;
  const before = prior.method;
  const after = current.method;
  const mismatch = comparisonFields.find(
    (field) => before[field] !== after[field],
  );
  if (mismatch) return { kind: "method_mismatch", field: mismatch } as const;
  const gap = current.observedToMs - prior.observedToMs;
  if (gap <= 0 || gap > 21 * 86_400_000) return { kind: "time_gap" } as const;
  return {
    kind: "comparable",
    displayDelta: current.headline - prior.headline,
    exactDelta: subtract(current.exactScore, prior.exactScore),
  } as const;
}
```

Acceptance tests must cover a real method tuple producing `+10`, a change to each of the required fields suppressing delta, and a newer incompatible prior blocking comparison across an older compatible point. The first regression below exercises the incorrect default-key acceptance using existing fixtures.

```ts
it("withholds a trend when only default comparison fields exist", async () => {
  await attempt("prior", "completed", baseline, {
    score: 80,
    comparabilityKey: testVerifiedKey,
  });
  await attempt("current", "completed", laterIso, {
    score: 90,
    comparabilityKey: testVerifiedKey,
  });
  expect((await row()).trendDelta).toBeNull();
});
```

### F03 · Exact grades and interval arithmetic diverge from the rubric and storage

**Confirmed by deterministic boundary and SQL probes.** `computeCanonicalRubricV1Score` uses floating arithmetic, a special case around 38 and a second near 90. Of 13,553 seeded two-decimal pillar tuples whose independent integer numerator lands exactly on 60/70/80/90, 1,888 were undergraded. `[99.88, 91.50, 80.39, 97.00, 68.00, 76.64]` in rubric order mathematically yields 90/A. The current function returns `89.99999999999999`, floor 89, grade B. The overview rejects a stored 90/A for this vector, while a stored 89/B can pass. This also happens at 60, 70 and 80. The interval reader falls back to `score` as earned mass whenever it is within coverage and can ignore a contradictory stored upper endpoint. SQLite persisted `73.25/88.25` in the `INTEGER` columns, while PostgreSQL 18.7 via PGlite coerced the same SQL values to `73/88`. The real service returned the different intervals. Metadata parity is green because both declarations say integer. PRD §3 and F02 require precise grading, unknown mass, and equivalent replay. [fleetCalculations.ts:49](./src/server/features/fleet/services/fleetCalculations.ts#L49) · [fleetEvidence.ts:40](./src/server/features/fleet/services/fleetEvidence.ts#L40) · [SQLite schema:209](./src/db/fleet.schema.ts#L209) · [Postgres schema:199](./src/db/pg/fleet.schema.ts#L199)

1. Compute score in exact rational form from rule credit counts and configured integer weights. Keep numerator and denominator as decimal strings if persisting them directly. Use `bigint` in the scorer, floor with exact integer division and use a number only at the presentation boundary. Remove magic epsilon, the 38 branch, and tolerance-based reconciliation with a caller-supplied score. If migrating legacy decimals, parse decimal strings at their existing scale. Never round inputs across a grade threshold.
2. Store verified earned mass and coverage. Derive the interval from them. Drop redundant persisted endpoints, or migrate both to a common exact representation if historical import requires them. Treat legacy values without certified mass as unknown. Treat a contradictory imported upper bound as invalid evidence.
3. Preserve exact unrounded score for fleet quantiles and exact trend. Floor the per-domain headline only. Test 0, 100, each boundary and the immediately lower representable values in the chosen storage representation. Test coverage below 80, at 80, at 85 and at 100, including the PRD example of score 85 with a missing 15-weight pillar yielding `[73, 88]`.

```ts
type Fraction = { n: bigint; d: bigint };
function fraction(n: bigint, d: bigint): Fraction {
  if (d <= 0n) throw new RangeError("Expected a positive denominator");
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
const add = (a: Fraction, b: Fraction) =>
  fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a: Fraction, b: Fraction) =>
  fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
const compare = (a: Fraction, b: Fraction) => a.n * b.d - b.n * a.d;
const cap = (value: Fraction, limit: Fraction) =>
  compare(value, limit) > 0n ? limit : value;
const headline = (exact: Fraction) => Number(exact.n / exact.d);

function provisional(
  earned: Fraction,
  coverage: Fraction,
  incidentCap: boolean,
) {
  const full = fraction(100n, 1n);
  if (
    compare(coverage, fraction(80n, 1n)) < 0n ||
    compare(coverage, full) >= 0n
  )
    return null;
  if (earned.n < 0n || compare(earned, coverage) > 0n) return null;
  const limit = fraction(incidentCap ? 59n : 100n, 1n);
  return {
    lower: cap(earned, limit),
    upper: cap(add(earned, subtract(full, coverage)), limit),
  };
}
```

For each observed rule use `weight = fraction(pillarPercent * ruleWeight, applicableRuleWeightSum)` with integer inputs. Add `weight` to coverage and `multiply(weight, creditFraction)` to earned mass. Keep missing weight out of both sums. An exact-boundary regression can be pasted into the service's calculation test today. A both-engine rule replay must own the replacement test after the scorer moves to rule counts.

```ts
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
```

### F04 · The critical cap checks timestamps and labels without proving the incident

**Confirmed at the incident parser.** Two distinct IDs and source strings at exactly the same timestamp make `http_5xx` and `malware_defacement` eligible with no probe target, observed result, or persistence policy. The allowed-code list has no branch for the PRD's sitewide indexing or homepage-plus-money-template rendering failures. It also makes a stale partial interval drop its previously valid cap because `currentFlag` gates the interval, while official points evaluate the historical cap at observation time. A historical fact should keep its original capped endpoints. Badge activity and the historical cap have different clocks. [fleetEvidence.ts:20](./src/server/features/fleet/services/fleetEvidence.ts#L20) · [fleetEvidence.ts:129](./src/server/features/fleet/services/fleetEvidence.ts#L129) · [FleetService.ts:234](./src/server/features/fleet/services/FleetService.ts#L234)

1. Replace `incidentReason`'s permissive JSON parser with a strict discriminated union over the three allowed families. Validate same property, expected production intent, independently derived collector identity, actual failed rule and its targets, evidence references, and timestamps. Encode origin retry/persistence rules in the rubric. Indexing requires proof of a sitewide policy mismatch. Rendering requires home and a predeclared representative money template, and verifies response MIME or rendered behavior.
2. Evaluate and persist historical cap from the verified observation envelope. Derive active critical state from incident recurrence and comparable resolving evidence. Keep a failed or truncated attempt from silently resolving an incident. Return independent fields for `historicalCapApplied` and current `criticalIncident`.

```ts
const common = {
  propertyId: nonemptyId,
  firstProbeId: nonemptyId,
  secondProbeId: nonemptyId,
};
const candidate = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("origin_failure"),
    origin: z.url(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("sitewide_index_block"),
    policyHash: sha256,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("critical_render_failure"),
    homeUnitId: nonemptyId,
    moneyUnitId: nonemptyId,
  }),
]);
const historical = verifyIncident(
  candidate.parse(input),
  panel,
  persistedProbes,
  snapshot.observedToMs,
);
const range = provisional(
  score.earnedMass,
  score.coverage,
  historical !== null,
);
```

`verifyIncident` must resolve both IDs from the trusted evidence manifest and require each probe to confirm the same rule-family failure under the panel and time policy. Test qualifying and disqualifying cases for all three families plus stale partial, provider challenges, and an unavailable follow-up. Current parser regression using the existing calculation imports follows.

```ts
const incidentTime = Date.parse("2026-11-22T10:00:00.000Z");
expect(
  parseIncidentConfirmation(
    {
      hasIncidentCap: true,
      observedAt: new Date(incidentTime).toISOString(),
      incidentReason: JSON.stringify({
        kind: "http_5xx",
        expectedIntentVerified: true,
        primaryProbe: { id: "a", source: "one", confirmedAtMs: incidentTime },
        corroborationProbe: {
          id: "b",
          source: "two",
          confirmedAtMs: incidentTime,
        },
      }),
    },
    incidentTime,
  ),
).toBe(false);
```

### F05 · Both databases accept rows with impossible tenant or resource lineage

**Confirmed on clean migrations in both engines.** Individual foreign keys admit a run whose organization differs from its roster's, an item whose member belongs to a different roster, and a snapshot whose member differs from its item. Project/audit links have the same single-key shape. Issue occurrences and change verifications repeat the pattern. The real repository already filters organization and roster on the run, validates mapped projects, and drops a snapshot whose member/project differs from its parent. I did not establish a cross-tenant HTTP read. The database still accepts combinations that the PRD explicitly forbids, and future history, export, verification and job consumers would have to reproduce every read-side filter. [fleet.schema.ts:108](./src/db/fleet.schema.ts#L108) · [pg/fleet.schema.ts:102](./src/db/pg/fleet.schema.ts#L102) · [FleetRepository.ts:210](./src/server/features/fleet/repositories/FleetRepository.ts#L210)

1. Give roster members, runs, items, and snapshots a non-null organization and required lineage columns. Add unique indexes for referenced tuples. Keep a stable `propertyId` across roster versions. Retain one immutable roster-entry ID per version. Derive child ownership through the authorized parent. Backfill from canonical parents, detect conflicts before adding constraints, and quarantine invalid rows.
2. Add the composite foreign keys in both Drizzle definitions and generate migrations. For nullable project/audit links use a nullable live mapping or explicit tombstone policy. Never use a nullable column inside the only FK enforcing mandatory tenant lineage. Apply the project/audit, issue/snapshot and change-event/before/after ownership rules at the same boundary. Keep ORM/DB enum and score bounds explicit where stored facts depend on them.

```ts
// Common shape in SQLite and PostgreSQL. Declare corresponding parent unique tuples.
foreignKey({
  columns: [item.organizationId, item.rosterVersionId, item.runId],
  foreignColumns: [run.organizationId, run.rosterVersionId, run.id],
}).onDelete("cascade");
foreignKey({
  columns: [item.organizationId, item.rosterVersionId, item.memberId],
  foreignColumns: [member.organizationId, member.versionId, member.id],
}).onDelete("cascade");
```

Use `(organizationId, runItemId, memberId)` for the snapshot parent FK. Keep explicit organization/project join filters on the RPC. Add a negative migration test against each driver. Valid parent rows in this test are fixture IDs from two independent roster versions.

```ts
await expect(
  db.insert(fleetRuns).values({
    id: "bad-run",
    organizationId: orgA,
    rosterVersionId: rosterB,
    requesterId: requestorA,
  }),
).rejects.toThrow();
```

Add sibling assertions for run/member, item/snapshot, project/audit, and change verification only where they exercise a different parent relationship. Add an RPC success case with a valid other-org fixture to prove it stays out of the returned payload.

### F06 · The approval hash omits the project assignments and enrollment decisions the importer writes

**Confirmed in source and the local manifest census.** The candidate contains 87 unique normalized host strings. Count and uniqueness do not prove the ownership set frozen under PRD §1. The importer hashes a projection before looking up projects. It then picks the earliest row for duplicate domains, writes every member as `active` with empty aliases, encodes member IDs using the roster version, and returns an existing version solely by matching the manifest hash. The approval object carries `approvedBy` as arbitrary text and optional time without verification against a trusted approval mechanism. Two deployments of the same approved bytes can assign different project IDs. An import can also record a valid-looking version whose exact mapping was never reviewed. The default implementation writes solely to local D1, with a check-then-insert race on a same-key retry. Existing import tests cover CLI and schema checks. Neither driver runs an authorized import/replay test. [fleetManifest.ts:24](./src/server/features/fleet/data/fleetManifest.ts#L24) · [import-fleet-roster.ts:32](./scripts/import-fleet-roster.ts#L32) · [import-fleet-roster.ts:104](./scripts/import-fleet-roster.ts#L104) · [import-fleet-roster.ts:136](./scripts/import-fleet-roster.ts#L136)

1. Split planning from application. Resolve active projects in the authorized organization and emit a strict plan with stable property IDs, canonical origin/host, aliases, approved exclusions, explicit enrollment/intent, repo/deploy references and one reviewed `projectId | null` per row. Reject duplicate normalized hosts, aliases crossing property identities, and ambiguous or foreign project matches. Use an explicit policy for parked and redirect-only entries. Validate the raw manifest, replacing permissive tier/intent/platform defaults.
2. Bind the digest to the sorted, versioned plan and approved org. Verify approval through an owner-authorized request or against a trusted signed offline approval bound to that digest and version. During apply, revalidate the exact mappings and approved time. Use the repository's [`runBatch`](./src/db/runBatch.ts) or a scoped backend transaction for both engines. Resolve unique conflicts by reading the winner and returning its ID only when the digest and persisted mapping match. Use a new version for a mapping change.

```ts
const plan = rosterPlanSchema.parse(await readPlan(planPath));
const members = [...plan.members].sort((a, b) =>
  a.canonicalHost < b.canonicalHost
    ? -1
    : a.canonicalHost > b.canonicalHost
      ? 1
      : 0,
);
const digest = sha256(
  canonicalJson({
    organizationId: plan.organizationId,
    versionTag: plan.versionTag,
    members,
  }),
);
await verifyOwnerApproval({
  approval,
  organizationId: plan.organizationId,
  versionTag: plan.versionTag,
  digest,
});
await assertApprovedProjectBindings(plan.organizationId, members);
return persistOrReturnIdenticalRoster({ plan, members, digest });
```

Use the same canonical serialization during plan and apply. For `persistOrReturnIdenticalRoster`, attempt one atomic write, query by `(organizationId, versionTag)` on a unique conflict, and fail when no same-digest complete version exists. The following regression at the hashing boundary describes the currently ignored field. In the finished import test, repeat it through apply and verify no rows are written on digest mismatch.

```ts
const before = FLEET_MANIFEST_MEMBERS.map((m) => ({
  ...m,
  projectId: "reviewed-a",
}));
const after = before.map((m, i) =>
  i === 0 ? { ...m, projectId: "different-b" } : m,
);
expect(hashCanonicalRosterPlan("org-a", before)).not.toBe(
  hashCanonicalRosterPlan("org-a", after),
);
```

### F07 · The checkout implements a preview reader without the PRD's scored pilot or launch path

**Confirmed by public-entry and writer inventory.** `/onsite` has one data RPC, `getFleetOverview`. Production references to `fleetSnapshots` outside schema/repository reads are absent. The existing per-project audit remains a useful outbound link. There is no fleet panel producer, settled run publication, observation checkpoint, comparison drill-down, scoped export, run detail, or draft workflow. Migrations provide tables for several of these concepts without code that verifies or uses them. PRD §§2, 4–8 require a narrow pilot with a repeatable baseline and proof. These are source deliverables. The Stage 2 checks on the eventual workflow carry zero deduction. [onsite.tsx:6](./src/routes/_app/onsite.tsx#L6) · [fleet.ts:16](./src/serverFunctions/fleet.ts#L16) · [AuditService.ts](./src/server/features/audit/services/AuditService.ts) · [siteAuditWorkflowPhases.ts](./src/server/workflows/siteAuditWorkflowPhases.ts)

1. Implement `requestFleetRun` through authenticated server function → `FleetRunService` → repository. Validate actor, roster, selection, approved origins and worst-case cost. Persist run intent under unique `(org, idempotencyKey)` and compare a canonical payload digest on retry. Allocate deterministic operation IDs before dispatch. In the tick, claim bounded work with conditional status/fence updates and bounded job deadlines. Pass the operation identity to the existing native audit service. Reconcile uncertain dispatch by that identity. Leave paid auto Lighthouse off until a provider reservation/reconciliation path exists.
2. Collect fixed-panel evidence before audit scratchpad teardown. Parse native observations at trust boundaries, preserve missing results as unknown, and reuse the existing crawler authorization and redirect controls. Sign or validate the content-addressed redacted evidence manifest before publishing. Keep arbitrary URL admission and provider callbacks disabled until their local negative tests pass.
3. Publish safely through the existing both-dialect batch seam. Make the fence and digest checks part of the writes. On D1, use SQL guarded on the expected fence/state with an atomic batch, and preserve typed outcomes distinguishing a legitimate replay, lease loss, and digest mismatch. On PostgreSQL, apply the same checks within a transaction. Persist the evidence before the database transaction and keep failed/unreferenced evidence eligible for grace-period garbage collection. Cancellation stops new dispatch and retains settled evidence. Report source observation and publication clocks separately.

```ts
export const requestFleetRun = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(runSelectionSchema) // selection, profile, and requestKey only
  .handler(async ({ context, data }) => {
    requireOrgPermission(context, { fleet: ["run"] });
    return FleetRunService.admit({
      orgId: context.organizationId,
      actorId: context.userId,
      request: data,
    });
  });

async function publishFleetResult(
  claim: FleetClaim,
  panel: FrozenPanel,
  results: RuleObservation[],
) {
  const evaluation = evaluatePanel(panel, results);
  const artifact = await privateEvidence.putIfAbsentByDigest(
    redactAndBound(panel, results),
  );
  return FleetPublication.commitIfFenceMatches({ claim, evaluation, artifact });
}
```

4. Add scoped `getDomainHistory`, `compareSnapshots`, and the fixed-checkpoint overview projection next. Use F02 comparisons, `floor(current) - floor(previous)` for the display, and a fixed-cohort median from the intersection of comparable properties at the two named checkpoints. Return exact raw deltas and reasons. Support authorized filtered export in the same service contract with content sanitization and the displayed run/roster/rubric metadata. Implement durable run detail and draft-only remediation after publication and auth are proven. Bind a draft to evidence, org, project, approved revision, registered skill and paths, and keep release authorization in the existing deployment flow.

```ts
it("retries the same admission and publication without creating a second point", async () => {
  const first = await requestAsOperator(sameSelection);
  expect(await requestAsOperator(sameSelection)).toMatchObject({
    runId: first.runId,
  });
  await expect(
    requestAsOperator({ ...sameSelection, profile: "different" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await finishWithFixtureEvidence(first.runId);
  await finishWithFixtureEvidence(first.runId);
  expect(await readPublishedPoints(first.runId)).toHaveLength(1);
});
```

Add a stale-fence test and a crash-before-evidence/after-evidence test with actual storage adapters. The PRD calls for a fixture pilot before paid scheduling, rollout or remediation dispatch. The preview can be independently reviewed against a formally approved reduced contract, but F01–F06 still block its use as an authoritative score view.

## P2 findings

### F08 · The attempt overlay omits observed state and the read grows with historical runs

**Confirmed in source and in both service adapter probes.** After a persisted `skipped` item completed on November 22, `latestAttemptAt` still reported November 21. `resolveTerminalAttempts` admits only completed, failed, and partial. Major PRD statuses such as unavailable and cancelled have no enum value. The overview cannot show live run activity or explain the skip. Sparse preview data can make “Never Audited” look definitive even though the native audit lane has data and no fleet publisher has evaluated it. Four query calls avoid N+1, but two fetch all run items and snapshots for an entire roster version, select unused evidence fields, and sort histories repeatedly. A fixed query count provides no cardinality bound. [fleetObservations.ts:26](./src/server/features/fleet/services/fleetObservations.ts#L26) · [FleetService.ts:117](./src/server/features/fleet/services/FleetService.ts#L117) · [FleetRepository.ts:148](./src/server/features/fleet/repositories/FleetRepository.ts#L148)

1. Represent weekly scoring disposition, latest attempt, and active overlay independently. Return a typed status, time, and reason for every admissible attempt. A skip or cancellation can remain visible beside the prior weekly score. Keep `unmapped` and explicit intent-based `exempt` ahead of attempt outcomes. Rename “Never Audited” in preview to clarify that it means “No fleet baseline”. Remove legacy Tier 4 inference because the approved exemption state owns policy.
2. Store one normalized UTC epoch representation for ordering on both drivers. Query the newest entry and latest two published points per stable property, plus the current attempt/active run. Use indexed window/ranked selections after publication validation makes each row eligible at read time. Keep older history accessible through a separately paginated path. Test late completion versus observation order, skip and cancel beside last good data, disposition conservation, and per-property row counts with two years of fixture history.

```sql
WITH ranked AS (
  SELECT s.*, row_number() OVER (
    PARTITION BY property_id ORDER BY observed_to_ms DESC, id DESC
  ) AS position
  FROM fleet_snapshots AS s
  WHERE organization_id = :org AND series_key = 'weekly-baseline'
    AND publish_state = 'published' AND grade <> 'ungraded'
    AND observed_to_ms <= :as_of
)
SELECT * FROM ranked WHERE position <= 2;
```

Add an index on `(organization_id, series_key, property_id, observed_to_ms, id)`. Run a separate bounded query for the latest attempt/partial or combine it in the same projection. Use a single captured `asOf` across the repository and service to keep approval, observation, and freshness cutoffs consistent.

### F09 · The rendered overview can keep loader data after organization revalidation

**Confirmed by component control flow.** `initialOrgId ?? orgContextQuery.data?.organizationId` gives loader state precedence. The condition to populate initial data then compares that same preferred ID and can keep the old query key. An organization query error renders an error card and leaves the overview branch eligible. The RPC correctly rejects requests with mismatched active organization and expected organization. The existing sidebar switch performs a full navigation. The observed defect is retained client data after revalidation in a mounted view, such as a workspace change from another tab. No unrelated-tenant RPC disclosure was demonstrated. `fleet.test.ts` mocks the TanStack server function and authentication middleware, so it cannot establish the normal entry-point auth contract. [FleetOverviewView.tsx:31](./src/client/features/fleet/FleetOverviewView.tsx#L31) · [FleetOverviewView.tsx:91](./src/client/features/fleet/FleetOverviewView.tsx#L91) · [Sidebar.tsx](./src/client/components/Sidebar.tsx) · [fleet.test.ts:23](./src/serverFunctions/fleet.test.ts#L23) · [start.ts](./src/start.ts)

1. Seed the organization and fleet queries in one authorized loader pass using the existing router query client. Use organization-query data for the mounted view. Prevent fleet content from rendering when workspace context is unconfirmed or has errored. Clear the previous fleet cache on session or active-workspace invalidation and never use a cross-workspace placeholder. Keep the expected organization assertion in the RPC.
2. Add a mounted-component check where initial A data is followed by organization B or a denied context. Assert that A's host disappears before B's query resolves. Add a local Start dispatch test with normal auth and CSRF middleware for anonymous, wrong org, wrong role and entitled member. Stub external identity at the trusted provider adapter with test principals. Assert repository access and response content at the public boundary.

```tsx
const org = useQuery(organizationContextQueryOptions());
const orgId = org.isSuccess ? org.data.organizationId : undefined;
const fleet = useQuery({
  ...fleetOverviewQueryOptions(orgId),
  enabled: orgId !== undefined,
  initialData:
    orgId !== undefined && orgId === initialOrgId ? initialData : undefined,
});
if (org.isPending) return <WorkspaceLoading />;
if (org.isError) return <WorkspaceError query={org} />;
if (!orgId) return <WorkspaceRequired />;
return <FleetQueryContent key={orgId} query={fleet} />;
```

### F10 · The matrix drops row context and understates scope and unavailable data

**Confirmed in local React markup and the view model.** The matrix puts the domain in a `td`, giving assistive table navigation no explicit row header. The native caption, `aria-sort` and named keyboard-scroll region work in its favor. The reset button disappears on activation because it is rendered only during custom sort. Its focus target disappears with it. Zero roster rows and filtered no-match results share the same message. The matrix shows three of six pillars as sortable columns, the rest are behind a disclosure, and there is no age column, evidence-linked driver or separate fixed-cohort denominator. Fleet cards have no disposition counts, lower quartile, or latest run/status/spend. The sort groups negative deltas then uses hostname, so a small decline can precede a larger one. `DESIGN.md` passes the structural validator. Its “Ready”, tested keyboard/contrast and closed-gates statements are stronger than the checked-in component evidence. [FleetMatrixRow.tsx:113](./src/client/features/fleet/FleetMatrixRow.tsx#L113) · [FleetMatrixTable.tsx:80](./src/client/features/fleet/FleetMatrixTable.tsx#L80) · [FleetOverviewView.tsx:203](./src/client/features/fleet/FleetOverviewView.tsx#L203) · [fleetSort.ts:25](./src/client/features/fleet/fleetSort.ts#L25) · [DESIGN.md](./DESIGN.md)

1. Use a row header for the domain and `scope="col"` for column headers. Keep the triage reset target mounted with `aria-disabled` when inactive, or explicitly return focus to a stable table header. Group labelled filters and preserve visible focus. Keep missing values last and sort adverse deltas by size inside their priority bucket. Provide a dedicated zero-roster state and a reset action for a filtered empty result.
2. Add the six pillar values, coverage, age, incident reason, and biggest comparable driver to the matrix contract. Retain visible coverage and last-good dates for unavailable/partial statuses. Keep keyboard access to all columns through the native scroll region and expose a compact mobile disclosure with the same values and labelled actions. Add the disposition counts, roster/run metadata, lower quartile and fixed-cohort median with their denominators after the service publishes them. Show “Unavailable” for absent provider metadata rather than a fabricated zero.
3. Update `DESIGN.md` with local fixture evidence after the changes. Render no roster, no matches, loading, generic error/retry, auth denial, unavailable with last good, measured zero, partial, and fresh graded. Verify caption, row/column associations, sort announcements, button/link names and keyboard focus after resetting triage. Capture narrow/wide layout fixtures locally. Live captures remain Stage 2.

```tsx
<TableHead scope="row" className="font-medium">{domain.canonicalHost}</TableHead>
<button type="button" aria-disabled={sortField === "triage"}
  onClick={() => { if (sortField !== "triage") onSort("triage") }}>
  Reset to triage priority
</button>
<p role="status">{totalDomains === 0 ? "No enrolled properties in this roster." :
  visibleCount === 0 ? "No properties match these filters." : `Showing ${visibleCount} of ${totalDomains} properties`}</p>
```

### F11 · Strict compilation passes while source contracts and merge checks remain incomplete

**Confirmed by tool output and test review.** Root and BadSEO `tsc --noEmit` pass. Knip reports eight unused fleet value exports and two unused fleet type exports. With line endings normalized for audit only, Prettier reports fleet-owned deviations in `fleetEvidence.ts` and `fleet-overview.integration.test.ts`. `FleetDomainSummary` widens enum fields to `string`; clients import those types directly from the server service. Optional overlay fields and duplicate attempt-status aliases allow multiple states for the same persisted fact. The app's storage integration test supplies the SQLite adapter and migration, and the schema parity test compares declarations. Both are useful. Neither finds the PostgreSQL interval difference. Unit tests that almost exclusively vary stored summaries cannot prove rule data integrity or exact grades. [fleetCalculations.ts:24](./src/server/features/fleet/services/fleetCalculations.ts#L24) · [FleetService.ts:28](./src/server/features/fleet/services/FleetService.ts#L28) · [fleetObservations.ts:8](./src/server/features/fleet/services/fleetObservations.ts#L8) · [schema-parity.test.ts:193](./src/db/schema-parity.test.ts#L193)

1. Put the RPC response type in `src/shared/fleet.ts` and use the enum unions plus a discriminated graded/partial result. Reuse the existing enum arrays for typed filter controls. Remove unused re-exports and the duplicate status aliases. Keep canonical parsing in one place. Move the incident code enum to the verified evidence model and make the actual rule scorer an ordinary production caller.
2. Add only the missing tests at their owning boundaries. Parameterize one migration-to-overview suite across `libsql` and local PostgreSQL. Let the real rule evaluator own numeric properties and one end-to-end test own admissions/replay. Middleware proof belongs at the real Start dispatch boundary and accessibility proof belongs at the rendered matrix, as described in F09/F10.
3. Format only fleet-owned paths, run both TypeScript checks, Knip, Oxlint, focused tests, both migration checks and the app suite. Fix or rebaseline unrelated CI failures separately. The line-ending flood can be reproduced on `core.autocrlf=true`; use the logged Windows workaround for targeted inspection or establish an LF checkout policy through maintainer review.

```ts
type FleetScoreView =
  | {
      kind: "graded";
      headline: number;
      grade: FleetOfficialGrade;
      coverage: 100;
    }
  | {
      kind: "partial";
      coverage: number;
      interval: ProvisionalRange | null;
      missingRules: readonly string[];
    }
  | { kind: "unavailable"; coverage: null };

type FleetRow = {
  tier: FleetTier;
  platform: FleetPlatform;
  siteIntent: FleetSiteIntent;
  health: FleetScoreView;
};
```

```powershell
pnpm exec prettier --write src/server/features/fleet/services/fleetEvidence.ts scripts/fleet-overview.integration.test.ts
pnpm types:check
pnpm exec tsc --noEmit -p tests/badseo/tsconfig.json
pnpm knip
pnpm lint
```

## Verification record

| Verification                                                                                                                                                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run src/server/features/fleet/services/FleetService.test.ts src/serverFunctions/fleet.test.ts scripts/import-fleet-roster.test.ts scripts/fleet-overview.integration.test.ts src/db/schema-parity.test.ts --maxWorkers 2` | **PASS**. 370 tests in five files. Fleet fixtures cover stale/partial/failed cases, delayed completions, host drift and foreign-run exclusion. The parity suite compares Drizzle schema metadata.                                                                                                                                                                                                                                                           |
| `pnpm types:check` and `pnpm exec tsc --noEmit -p tests/badseo/tsconfig.json`                                                                                                                                                               | **PASS**. Both commands exited 0.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm exec drizzle-kit check --config drizzle/sqlite.config.ts` and `pnpm exec drizzle-kit check --config drizzle/pg.config.ts`                                                                                                             | **PASS**. Both migration metadata checks exited 0.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Clean migration execution                                                                                                                                                                                                                   | **PASS**. Applied 57 SQLite journal entries using in-memory SQLite and 35 PostgreSQL journal entries using PGlite 0.5.17 / PostgreSQL 18.7. No production binding or PostgreSQL wire connection was used.                                                                                                                                                                                                                                                   |
| Independent both-engine integrity and read probes                                                                                                                                                                                           | **FAIL** for the PRD contract. Each engine accepted tenant/roster, run/member and item/snapshot inconsistencies. The real repository and service, using Drizzle libSQL and PGlite adapters, returned 90/A and `+10` with zero rule rows, skipped a later settled attempt, and emitted divergent intervals `[73.25, 88.25]` and `[73, 88]`.                                                                                                                  |
| Deterministic score/incident probes                                                                                                                                                                                                         | **FAIL** for exact-boundary grade, full/default method identity, interval evidence and incident-family policy. The grade sample used 300,000 generated candidate tuples, with 13,553 solving to an exact boundary. The independent oracle used integer hundredths × integer rubric weights and counted 1,888 negative one-point errors. Counts by boundary were 1,055 at 60, 678 at 70, 153 at 80, and 2 at 90.                                             |
| Design contract validator and local markup                                                                                                                                                                                                  | Validator **PASS**, one page and 13/13 principles. React static markup confirmed caption, named focusable scroll container, active sort state and a measured zero. It lacked domain row headers. Source inspection established the conditional focus-target removal. No interactive keyboard timing, CSS contrast measurement, or live evidence is claimed.                                                                                                 |
| `pnpm knip` and `pnpm lint`                                                                                                                                                                                                                 | **FAIL**. Knip reported ten fleet exports/types and two unrelated exports. Type-aware Oxlint found two errors in `src/custom/serpCache{,.test}.ts` and no fleet diagnostic.                                                                                                                                                                                                                                                                                 |
| `pnpm format:check` and targeted `prettier --check --end-of-line auto`                                                                                                                                                                      | **FAIL**. Default check flagged 1,330 paths under this Windows checkout. The line-ending-normalized fleet check isolated `fleetEvidence.ts` and `scripts/fleet-overview.integration.test.ts`.                                                                                                                                                                                                                                                               |
| `pnpm test:ci`                                                                                                                                                                                                                              | **FAIL overall**, 227 files passed / seven failed, 1,725 tests passed / eleven failed. Failed files were outside the fleet suites. A focused serial rerun with Git Bash on `PATH` cleared preview-access cases and the child-process timeouts in string retention and audit workflow helper tests. Three Google temp-directory cleanup failures and the SAM LF-only frontmatter matcher remained. These failures do not establish new defects in `/onsite`. |

### PRD acceptance at the local source boundary

| PRD gate               | Stage 1 disposition                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 roster             | Candidate census of 87 unique normalized strings confirmed. Approval-bound assignment, reviewed exclusions/aliases, stable identity, and both-engine replay remain open. |
| F02 scoring            | Both engines admit summary-only “official” points. Exact-boundary and partial/cap behavior fails.                                                                        |
| F03 comparability      | Default method keys compare and complete method keys fail comparison. Fixed-cohort and explainable comparison are missing.                                               |
| F04 durability         | No normal fleet publication, reconciliation, or fault-injected lifecycle entry point. Both-schema lineage needs repair.                                                  |
| F05 cost and limits    | No fleet admission reservation or bounded scheduler to exercise with local fixture demand. Existing provider services remain separate.                                   |
| F06 attribution        | Schema placeholders exist. No local implementation connects a confirmed revision, evidence before/after and controls.                                                    |
| F07 authorization      | Existing overview authorization and scoped reads satisfy useful structural checks. Normal middleware exercise and future per-action authorization remain open.           |
| F08 UX and reliability | Preview table and state infrastructure exist. Data, accessible focus and markup gaps remain. Live checks are Stage 2.                                                    |
| F09 release recovery   | Fail-closed overview flag exists in source. Local settlement/replay and retention protection wait for the publication path. Live rollback and restore are Stage 2.       |

### Remediation order and rerun gate

1. **Bind ownership first.** Apply F05/F06. Test on two local engines with a fresh schema and one upgrade fixture. Approval, storage, and read should agree on stable scope.
2. **Make one score reproducible.** Apply F01–F04 and the admission/publication nucleus of F07. Use a small fixed panel with observed, missing and conflicting rule evidence. Prove 68 → 85, an 85%-coverage `[73, 88]` interval, identical intervals after replay, and digest/fence recovery on both engines.
3. **Expose operator state.** Apply F08–F10 to the preview and connect domain history, fixed-cohort read and run detail after the writer is reliable. Verify authorization at the real local entry points and render all defined states. Gate export and draft actions on their own regression tests.
4. **Rerun the gate.** Apply F11, run the five focused suites plus the new owning-boundary tests, both typechecks, Drizzle checks, targeted formatting, Knip and type-aware Oxlint. Reassess all six vectors with current evidence. A score of at least 8.0 in every vector and zero remaining P0/P1 are required.
