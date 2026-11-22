# OpenSEO Aggregated Fleet View Stage 1 review

**Engineer Sol · 2026-11-22 · 6.9 / 10.0 · Stage 1 acceptance withheld**

The repository’s focused test set passes, including the SQLite overview integration and Drizzle metadata parity. Four additional SQLite cases failed at the overview boundary. The next generated migration fails against the SQLite schema created by the current migration. Other material defects affect comparable trends, weekly status, score precision across dialects, confirmed incidents and roster import approval. Type-aware lint is also red.

## Review boundary and score

I reviewed the local working tree on base `0512c7423284a58283723a61cdea57b5b36b485e`, including its modified and untracked fleet implementation. I did not consult earlier audit reports or scores. `FleetService.ts` had SHA-256 `4ec07a578c0968d7c252248f6160d92b5782c1ce47620c172e7c9f1515e9e27d` and `fleetCalculations.ts` had SHA-256 `4946348bc1e0e307694983b75babf48d09c01657b3b7c10f3c7e4454a242c071`.

The acceptance surface is the private, read-only preview in [DESIGN.md](DESIGN.md#verification), with score and roster semantics from §§1–5 and §7 of the owner PRD, `OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md`. Launch workflows such as crawl scheduling, remediation dispatch and export lie outside this preview. Cloudflare Access wire behavior, live bindings and migrations, deployed responsive screenshots and edge p95 received zero deduction. PostgreSQL server replay was unavailable locally. PostgreSQL evidence below is migration and schema inspection plus an executable numerical model explicitly labelled as such.

I weighted the six requested vectors equally because the request specified no vector weights. The unrounded mean is 6.9167. P1 marks a material Stage 1 defect, P2 marks a bounded correctness, design or verification defect. No P0 was found.

| Vector                              | / 10 | Basis                                                                                                                                                              |
| ----------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Architecture & Contract Soundness   |  7.0 | Clear read path and lineage checks. Attempt identity and roster dispositions are incomplete. The query fan-out exceeds the stated design.                          |
| Persistence & Dual-Dialect Parity   |  6.0 | Both constraints exist. Stale Drizzle metadata generates incompatible follow-up DDL. PostgreSQL `real` undermines scoring parity.                                  |
| Edge Cases & Numerical Robustness   |  6.5 | Core weighting, zero, stale and dual-clock cases work. Trend, incident and invalid percentage cases fail.                                                          |
| Security & Authorization            |  7.0 | The read RPC checks auth, active organization, configured entitlement and role. Local import does not verify the authority for the exact roster it writes.         |
| Accessibility & Design              |  8.0 | Semantic table, controls and numeric layout. Dark selected controls fail AA, and loading announcements and some card typography fall short of the source contract. |
| Code Quality, Strict Typing & Tests |  7.0 | Strict `tsc` and focused formatting passed. Type-aware lint fails and the green suite misses material persistence and entry-point behavior.                        |

## Stage 1 checks

| Check                                                                                                                                                                                | Observed result                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run src/db/schema-parity.test.ts src/server/features/fleet src/serverFunctions/fleet.test.ts src/client/features/fleet scripts/fleet-overview.integration.test.ts` | **335 passed in 4 files.** The client filter did not add a fifth suite.                                                                                                                                                               |
| Additional cases through `FleetService.getOverview()` and the existing in-memory libSQL fixture                                                                                      | **6 added probes, 2 passed, 4 failed.** The temporary suite ran 35 cases total, including the 29 existing integration cases. The new failures are recorded in F01, F02, F05 and F06. The temporary test file was removed.             |
| `pnpm exec tsc --noEmit` and focused `pnpm exec prettier --check …`                                                                                                                  | Both passed.                                                                                                                                                                                                                          |
| `pnpm exec oxlint … --type-aware` over fleet source, route, CLI and focused suites                                                                                                   | **Failed with one error**, `no-unnecessary-type-assertion` at `fleetCalculations.ts:306`.                                                                                                                                             |
| `pnpm exec knip --no-progress`                                                                                                                                                       | Reported two unused exports in `src/custom/serpCache.ts`, outside fleet scope. The fleet score excludes them.                                                                                                                         |
| Local design contract validator                                                                                                                                                      | **Passed**, 1 inventory entry, 1 contract, 13/13 principles. This verifies document structure.                                                                                                                                        |
| SQLite 3.50.4, in-memory replay in journal order                                                                                                                                     | 56 preceding migrations applied, followed by the fleet migration. It created ten fleet tables, with an empty `foreign_key_check`. Both duplicate-key inserts failed at the intended constraints. Multiple unmapped rows were allowed. |
| PostgreSQL artifacts                                                                                                                                                                 | Both required indexes are in the Drizzle schema and SQL. A dry generation reproduced duplicate columns and indexes. No PostgreSQL engine ran. A float32 model exercised the production grader.                                        |
| CLI subprocesses using `node --import tsx`                                                                                                                                           | `--help` exited 0. No arguments exited 1 with usage. Unknown flags and missing option values exited 1 with uncaught Node stacks. These commands never reached D1. Valid import and disposal were inspected in source.                 |
| Drizzle Kit generation from copied migration directories                                                                                                                             | Generated a new fleet migration for both dialects with the current schema. Replaying the generated SQLite SQL after the real fleet migration failed with an index-already-exists error. See F12.                                      |
| Roster fixture                                                                                                                                                                       | 87 rows and 87 distinct lower-case canonical hosts. Ownership and mapping approval require their own evidence.                                                                                                                        |

## Contract audit

| Probe                           | Stage 1 result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rubric v1 and displayed grade   | **Pass for exact SQLite inputs.** Recomputed `35/15/10/15/5/20` weights yield the PRD’s `68/D`, `82/B` and `85/B` examples. A raw `89.9` accepts headline `89/B` and rejects `90/A`. The gate requires non-provisional 100% coverage, all six finite in-range pillars, and stored raw or headline reconciliation. Grade uses `Math.floor(rawScore)`. PostgreSQL numeric fidelity is F03.                                                                                                                  |
| Weekly baseline and trend       | **Partial.** Only exact `weekly-baseline` snapshots qualify for headline grading. A completed diagnostic snapshot cannot replace that headline. An intervening incompatible **graded** weekly snapshot suppresses the delta even if an older point matches. Two unverified matching keys can still yield a trend, and diagnostic partials can suppress a legitimate headline.                                                                                                                             |
| Dual clocks                     | **Pass.** Invalid or future completion times are rejected. Observations must be valid, at or before `now`, and at or before the admitted parent’s completion. A new probe used two past clocks with the observation one hour after its parent and verified that the prior 85 remained current.                                                                                                                                                                                                            |
| Snapshot-less partial           | **Pass for the weekly case.** A current partial without its own snapshot returns null coverage and six null pillars, with historical last-good score and date retained. F02 covers scope collisions among different attempts.                                                                                                                                                                                                                                                                             |
| Unique indexes                  | **Pass.** `(version_id, project_id)` and `(run_item_id, series_key)` are unique in both schemas and migrations. SQLite executed both duplicate rejections on materialized tables. Nullable `project_id` supports multiple unmapped rows. Nullable `series_key` permits multiple unknown-series snapshots on an item, and those rows are excluded from official weekly scoring. Migration generator metadata is stale in both dialects (F12).                                                              |
| Coverage and critical incidents | **Partial.** Real `0%` survives as zero while absent evidence remains null through the service and table. Out-of-range metrics leak into the UI and a fresh bare cap flag counts as confirmation.                                                                                                                                                                                                                                                                                                         |
| Authorization and error mapping | **Pass on inspected read wiring and the handler’s unit cases.** The server selects organization from authenticated context, checks configured org and `fleet:view`, and treats the client’s expected org as a consistency check. Tenant and roster lineage constrain run items and attached snapshots. Global middleware maps typed errors to client codes. The seven RPC tests stub TanStack and auth middleware, so they cover the handler gate rather than full auth composition. CLI approval is F04. |
| UI and CLI usability            | **Partial.** Numeric headline values and sortable matrix columns use `tabular-nums`. Table caption, `aria-sort`, `aria-pressed`, named disclosure/action controls and result-count status are in source. Contrast and loading gaps remain. CLI uses strict `parseArgs`, local D1 and `finally` disposal after platform initialization, with incomplete input validation and uncaught parser errors.                                                                                                       |

## Findings

### F12 · P1 · Stale migration snapshots generate an invalid next migration

Both journal-head Drizzle snapshots describe an older version of the fleet schema. They omit both required unique indexes, `series_key` and `comparability_key`. They still describe `score` as integer and several pillar columns as non-null with default zero. The current SQL and TypeScript schema already contain the newer definitions. Running `drizzle-kit generate` against copies of both histories created redundant fleet DDL. SQLite emitted a snapshot table rebuild and a duplicate roster index. Applying that generated SQL after the current migrations failed with `index fleet_roster_members_version_project_idx already exists`. PostgreSQL generated duplicate column and index additions. Its DDL was inspected locally. The next routine schema change can therefore fail even when the initial install and metadata parity tests pass. [SQLite snapshot](drizzle/sqlite/meta/0056_snapshot.json) · [PostgreSQL snapshot](drizzle/pg/meta/0034_snapshot.json) · [SQLite SQL](drizzle/sqlite/0056_modern_zarda.sql) · [PostgreSQL SQL](drizzle/pg/0034_nifty_mongoose.sql)

### F01 · P1 · Equal arbitrary comparison keys produce a trend

`computeTrendDelta` requires matching, nonblank text. Two otherwise valid weekly snapshots with the same wildcard produced `+4` through the regular overview API. The existing “same panel” test uses `"a"` without any bound panel, applicability, collector or profile metadata. Matching arbitrary text cannot prove the PRD §4 comparison identity. This can show a false improvement or regression without affecting the validity of either standalone headline. [`fleetCalculations.ts:272`](src/server/features/fleet/services/fleetCalculations.ts#L272) · [`fleetCalculations.ts:324`](src/server/features/fleet/services/fleetCalculations.ts#L324) · [`fleet-overview.integration.test.ts:254`](scripts/fleet-overview.integration.test.ts#L254)

### F02 · P1 · Diagnostic attempts can override the weekly evidence path

The service chooses the latest terminal attempt across the entire member/project. For a partial it takes that item’s newest observation from **all** series. In the local fixture a weekly 85 became `fresh_partial`, headline null and coverage 60 after a diagnostic-only partial. A failed diagnostic can also mark the weekly row unavailable, and a weekly partial with only a diagnostic observation can display diagnostic pillars as its current evidence. `lastObservedAt` sometimes contains completion time when the partial has no observation. There is no persisted attempt-level scope for a snapshot-less attempt. [`FleetService.ts:103`](src/server/features/fleet/services/FleetService.ts#L103) · [`FleetService.ts:206`](src/server/features/fleet/services/FleetService.ts#L206) · [`FleetService.ts:291`](src/server/features/fleet/services/FleetService.ts#L291) · [`fleet.schema.ts:149`](src/db/fleet.schema.ts#L149)

### F03 · P1 · PostgreSQL storage can change grade eligibility

SQLite `REAL` preserves binary64 score inputs. PostgreSQL `real` stores binary32 even though Drizzle labels both columns `number`. The SQLite fixture with six pillars of `89.999999` and a stored headline `89/B` passed. Passing the binary32 round-trip of those pillars into the production grader yielded pillars of `90` and a rejected point. Analogous rounding occurs at 60, 70, 80 and 100. Independently quantized inputs can make the stored score and grade disagree with the recalculated result. This is a source-backed representation mismatch with an executable numerical witness. No PostgreSQL server was run. [`fleet.schema.ts:196`](src/db/fleet.schema.ts#L196) · [`pg/fleet.schema.ts:188`](src/db/pg/fleet.schema.ts#L188) · [`0034_nifty_mongoose.sql:132`](drizzle/pg/0034_nifty_mongoose.sql#L132) · [`schema-parity.test.ts:62`](src/db/schema-parity.test.ts#L62)

### F04 · P1 · Import does not verify approval for the exact roster write

The CLI checks only `organizationId`. It declares `versionTag` and never verifies it. It does not require an approved manifest digest or verify the project map. The caller supplies the approver label or receives a hard-coded owner label. The import then hashes current in-tree members and chooses project IDs from local active projects. The latter decision can change independently of the approval file or of the digest recorded on the roster. A second, currently unused repository seed path has another approval-free write implementation. The affected principal is the authorized local operator relying on an approval for a specific import. The demonstrated issue is approval integrity in source, with no remote access claim. [`import-fleet-roster.ts:25`](scripts/import-fleet-roster.ts#L25) · [`import-fleet-roster.ts:59`](scripts/import-fleet-roster.ts#L59) · [`import-fleet-roster.ts:150`](scripts/import-fleet-roster.ts#L150) · [`FleetRepository.ts:73`](src/server/features/fleet/repositories/FleetRepository.ts#L73)

### F05 · P1 · Snapshot freshness substitutes for incident confirmation

A fresh partial with a cap bit and no incident reason, corroboration or intent check increments `criticalIncidentsCount`. This reproduced through SQLite with zero measured coverage. The same raw flag also controls the 59 cap used in score reconciliation, so a bad confirmation can depress a legitimate headline or alter triage. A fresh snapshot can also contain an older corroborating observation because the model has no separate confirmation clock. PRD §3 requires an eligible failure, fresh independent corroboration and expected-site intent. [`FleetService.ts:287`](src/server/features/fleet/services/FleetService.ts#L287) · [`fleetCalculations.ts:104`](src/server/features/fleet/services/fleetCalculations.ts#L104) · [`fleetCalculations.ts:140`](src/server/features/fleet/services/fleetCalculations.ts#L140) · [`fleet.schema.ts:204`](src/db/fleet.schema.ts#L204)

### F06 · P2 · Invalid percentages are displayed as measurements

The display path accepts any finite coverage and clamps pillar values. A persisted partial with coverage `101` and pillar `-1` returned `101%` coverage and `0%` technical, converting corrupt data into a measured failure. NaN may also propagate from `clampPercent` if received from a numeric driver. For a partial in `[80,100)` the overview currently provides coverage and pillars, while the PRD calls for a validated ungraded interval. The schema has interval endpoints and the read DTO discards them. [`FleetService.ts:98`](src/server/features/fleet/services/FleetService.ts#L98) · [`FleetService.ts:156`](src/server/features/fleet/services/FleetService.ts#L156) · [`fleet.schema.ts:199`](src/db/fleet.schema.ts#L199) · [`FleetMatrixRow.tsx:22`](src/client/features/fleet/FleetMatrixRow.tsx#L22)

### F07 · P2 · Argument errors bypass the CLI’s clean exit path

`parseArgs` runs outside a caught top-level boundary, and `void main()` leaves rejected promises unhandled. Unknown options and missing values emitted stack traces in real subprocesses. `JSON.parse` is assigned to a TypeScript-only shape, so valid JSON `null` would throw on field access. Repeated value flags collapse to the final option value unless checked through `tokens`. [`import-fleet-roster.ts:121`](scripts/import-fleet-roster.ts#L121) · [`import-fleet-roster.ts:150`](scripts/import-fleet-roster.ts#L150) · [`import-fleet-roster.ts:187`](scripts/import-fleet-roster.ts#L187)

### F08 · P2 · Dark selected filters fail contrast and loading lacks a named announcement

Active fleet filters and the Tier 1 badge use white text on dark `--primary`, calculated at **3.14:1**, below AA’s 4.5:1 for those small labels. The opaque card foreground passes at **18.10:1 light** and **13.33:1 dark**. From the CSS tokens, the small muted captions are approximately **4.73:1 light** and **5.61:1 dark** over the card with sRGB alpha composition. That falls short of DESIGN.md’s written `>7:1` target. The destructive headline number is **3.56:1 light** and **4.75:1 dark**. Its 24 px bold treatment meets the 3:1 AA large-text threshold. The result-count live region and error alert exist, but the workspace and fleet loading states display hidden skeletons with no named loading announcement. Card headlines have `tabular-nums`, while the supporting counts in captions do not. Source uses a system sans stack and has no fleet-specific Inter load. [`app.css:68`](src/client/styles/app.css#L68) · [`app.css:108`](src/client/styles/app.css#L108) · [`FleetFilterToolbar.tsx:41`](src/client/features/fleet/FleetFilterToolbar.tsx#L41) · [`FleetMetricCards.tsx:14`](src/client/features/fleet/FleetMetricCards.tsx#L14) · [`FleetOverviewView.tsx:72`](src/client/features/fleet/FleetOverviewView.tsx#L72)

### F09 · P2 · Overview reads all history and exceeds the stated query budget

The repository performs version, members, and mapped-project queries followed by two queries per 50 members. With 87 members and at least one mapping that is **7 queries**, against DESIGN.md’s **2–3**. The two history scans return all rows per chunk. The repository and service then repeat sorting or row work, and the standalone project-ID lookup is not chunked. Query count and row growth are source observations. No inference about deployed p95 enters the score. [`FleetRepository.ts:179`](src/server/features/fleet/repositories/FleetRepository.ts#L179) · [`FleetRepository.ts:227`](src/server/features/fleet/repositories/FleetRepository.ts#L227) · [`FleetService.ts:365`](src/server/features/fleet/services/FleetService.ts#L365) · [`DESIGN.md:101`](DESIGN.md#L101)

### F10 · P2 · Excluded enrollment can enter fleet denominators

The two dialects model `excluded` and `parked`, but the overview returns every roster row and derives exemption only from explicit `exempt` or a string tier outside the defined tier enum. An `excluded` member with admitted observations can enter the monitored total, grade distribution, median and triage. The PRD puts exclusions outside the roster count and leaves approved exemptions visible. An approved parked member’s treatment should follow explicit policy in the manifest. [`fleet.enums.ts:21`](src/db/fleet.enums.ts#L21) · [`FleetRepository.ts:187`](src/server/features/fleet/repositories/FleetRepository.ts#L187) · [`fleetCalculations.ts:207`](src/server/features/fleet/services/fleetCalculations.ts#L207) · [`FleetService.ts:405`](src/server/features/fleet/services/FleetService.ts#L405)

### F11 · P2 · Type-aware lint and green-suite coverage gaps

Type-aware lint fails on a redundant assertion in `computeTrendDelta`. Its mixed raw and admitted inputs also require a structural branch that treats `observedAtMs` as proof of admission. The production call already supplies admitted points. `grade` is widened to `string`, and `FleetService.ts` re-exports calculation helpers through a second surface used by tests. The focused suite tests SQLite service behavior and cross-dialect shape, while the RPC suite replaces the actual middleware and no targeted suite launches the CLI. Its only-null case is named as testing both null and empty comparison keys. [`fleetCalculations.ts:272`](src/server/features/fleet/services/fleetCalculations.ts#L272) · [`fleetCalculations.ts:306`](src/server/features/fleet/services/fleetCalculations.ts#L306) · [`FleetService.ts:17`](src/server/features/fleet/services/FleetService.ts#L17) · [`fleet.test.ts:19`](src/serverFunctions/fleet.test.ts#L19) · [`fleet-overview.integration.test.ts:408`](scripts/fleet-overview.integration.test.ts#L408)

## Implementation handoff

Repair the migration metadata first using F12 below. Apply the remaining changes through the normal importer or overview entry point. Keep the independent acceptance values in fixtures. The TypeScript regression blocks that call `attempt`, `row`, `client`, `baseline` and `later` can be appended to `scripts/fleet-overview.integration.test.ts`. SQL and code blocks labelled as target shapes refer to new types or columns introduced by the corresponding repair.

### 1. Persist and verify comparison identity (F01)

1. At weekly publication, canonicalize the verified normalized origin, project, rubric, panel membership/hash, applicability and weight manifest, collector and metric versions, and the exact profile including engine, device, region and origin/URL source scope. Require every dimension. Deployment revision can change within a series.
2. Store the canonical inputs with the snapshot or a referenced immutable method record. Compute a versioned SHA-256 fingerprint from a fixed ordered tuple. Recompute from those facts or use an immutable ID issued exclusively by the validating publisher. Existing opaque keys with no provenance produce null trend. A correct-looking digest alone does not establish provenance.
3. Preserve the immediately preceding graded weekly point within 21 days. If that point has unverified or different metadata, return null delta and a reason. Keep the displayed integer difference as the UI delta.

```ts
// Target shape at the trusted publication and read-admission boundary.
const comparisonInputs = [
  "weekly-comparison-v1",
  projectId,
  canonicalOrigin,
  rubricVersion,
  panelHash,
  applicabilityWeightsHash,
  collectorVersion,
  metricVersion,
  labProfileHash,
  sourceScope,
] as const;
const comparisonKey = createHash("sha256")
  .update(JSON.stringify(comparisonInputs))
  .digest("hex");

// Stored metadata is validated and bound to this project before trend use.
if (
  !previous ||
  !current.verifiedComparisonKey ||
  current.verifiedComparisonKey !== previous.verifiedComparisonKey
)
  return null;
```

```ts
it("keeps weekly grade and suppresses an unverified trend", async () => {
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
```

Replace the `"a"` positive fixture with actually verified metadata and retain `+6`. Vary one dimension at a time. Include null, empty, whitespace, wildcard, or identical whole metadata and test against the immediate predecessor when an older point matches.

### 2. Scope the attempt and observation clocks (F02)

1. Add an attempt-level `primarySeriesKey` in both dialects and set it at admission. Carry it through the repository. Backfill only rows with verified scope and leave ambiguous legacy snapshot-less rows unknown. Represent any latest diagnostic outcome independently if operators need it.
2. Keep clock admission for all lineage-validated rows. Derive the latest weekly attempt from declared scope, and use its own exact weekly observation for an incomplete attempt. Continue to order admitted completed weekly observations by observation time, so an older observation completing late cannot replace a newer point.
3. Keep the authoritative last-good weekly point separate. Expose `lastAttemptCompletedAt` when needed and leave `lastObservedAt` null whenever there is no observation.

```ts
const weekly = admittedObservations.filter(
  ({ snap }) => snap.seriesKey === "weekly-baseline",
);
const latestWeeklyAttempt =
  admittedTerminalAttempts.find(
    ({ item }) => item.primarySeriesKey === "weekly-baseline",
  )?.item ?? null;
const current =
  latestWeeklyAttempt?.status === "partial"
    ? (weekly.find(({ snap }) => snap.runItemId === latestWeeklyAttempt.id)
        ?.snap ?? null)
    : (weekly[0]?.snap ?? null);
const lastObservedAt = current?.observedAt ?? null;
```

```ts
it("leaves a valid weekly headline intact after a diagnostic partial", async () => {
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
```

Extend the fixture to populate `primarySeriesKey` explicitly. Cases required alongside the one above include diagnostic failure with no snapshot, weekly partial with only a diagnostic snapshot, weekly partial with no snapshots, weekly partial with its own weekly evidence, and an observation strictly after its parent but before `now`.

### 3. Keep score precision through migration and readback (F03)

1. Use Drizzle `doublePrecision` for PostgreSQL snapshot `score`, `coverage` and all six pillar scores. Keep SQLite `real`. Align persisted median and rule-score precision where those feed the composite. Use a forward migration if the existing migration has already been applied in any environment.
2. Change the column definitions as well as the DDL. A storage widening preserves future values. Existing float32 loss cannot be reversed without retained inputs, so recompute affected historic points from those inputs where provenance permits.
3. Add a local migration-and-readback test on PostgreSQL, using the shared overview fixture with each dialect. Assert the expected headline and grade at all cutoffs, fractional coverage just below 100, and a heterogeneous weighted example. Prefer that persisted behavior test over another schema-name comparison.

```sql
ALTER TABLE fleet_snapshots
  ALTER COLUMN score TYPE double precision,
  ALTER COLUMN coverage TYPE double precision,
  ALTER COLUMN score_technical TYPE double precision,
  ALTER COLUMN score_internal_links TYPE double precision,
  ALTER COLUMN score_mobile_perf TYPE double precision,
  ALTER COLUMN score_on_page TYPE double precision,
  ALTER COLUMN score_schema TYPE double precision,
  ALTER COLUMN score_ai_readiness TYPE double precision;
```

```ts
it("keeps 89/B after persisting pillars just below 90", async () => {
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
```

The oracle passes on SQLite now. The same case on PostgreSQL `real` is expected to fail based on the executed binary32 model (`Math.fround(89.999999) === 90`). Keep `Math.floor` exact and avoid rounding the headline upward to work around storage loss.

### 4. Bind importer approval to what is written (F04)

1. Parse the artifact as `unknown` and validate its exact fields. Bind approval to the target organization, current version, approved canonical host/member data and the per-host project mapping, including null mappings. Validate all mapped projects against active projects in the target organization. Reject a changed plan, with any new mappings issued as a new approval/version.
2. Use the repository-controlled, owner-reviewed approval artifact as the trust source. If the CLI accepts a freely selected file, require an owner signature verified with a pinned public key or match a digest from a separately trusted approval record. Derive the actor label from that trusted record. Apply the validated plan atomically, and compare its full digest on an idempotent retry. Remove the unused unverified seeder or give it the same verified input boundary if an actual caller requires it.
3. Exercise the normal CLI with a disposable D1 fixture. Assert zero writes and a deterministic exit for each rejected case. Then verify 87 expected rows, stable replay and atomic rollback on an insert failure.

```ts
const approvalSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  versionTag: z.literal(FLEET_MANIFEST_VERSION),
  rosterPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

// The trusted envelope returns a verified actor and parsed document bytes.
const { actorId, document } = await readVerifiedApproval(approvalPath);
const approval = approvalSchema.parse(document);
if (
  approval.organizationId !== targetOrgId ||
  approval.rosterPlanSha256 !== hashCanonicalRosterPlan(plan)
) {
  throw new CliUsageError("Approval does not match the target roster plan");
}
await persistApprovedPlan(db, plan, actorId);
```

An entry-point oracle using a dummy approved roster should invoke the CLI against a temporary config with `--approval` pointing to that artifact. Change the fixture’s plan or version, then assert exit 1, the approval mismatch message and zero roster rows. Run the unchanged authorized control next and assert exit 0 and the approved rows only. Include a mismatched mapping with unchanged hosts as its own case.

### 5. Require independently confirmed critical evidence (F05)

1. Persist a typed confirmation linked to the same snapshot or to its immutable evidence manifest. Require a known essential failure code, verified expected intent, two independent observations and a bounded confirmation time. Check the confirmation clock against the observation and the configured incident freshness requirement.
2. Compute the effective cap once and pass that same fact to score reconciliation, row flags, sorting and the fleet counter. Legacy cap flags lacking confirmation cannot impose a cap. If a stored score was already reduced to 59, keep it ungraded unless it reconciles without the unverified cap.
3. Keep a verified partial incident visible when the partial cannot be graded. Keep the card’s denominator semantics explicit as domains with a current confirmed flag.

```ts
const confirmedCap =
  snapshot.hasIncidentCap &&
  confirmation !== null &&
  essentialIncidentCodes.has(confirmation.kind) &&
  confirmation.expectedIntentVerified &&
  confirmation.independentCorroboration &&
  confirmation.confirmedAtMs <= observedAtMs &&
  confirmation.confirmedAtMs >= now - incidentFreshnessMs;
const rawScore = confirmedCap ? Math.min(59, uncapped) : uncapped;
```

```ts
it("does not treat a bare partial cap flag as confirmed", async () => {
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
```

Add a corroborated grade-cap case from uncapped 90 to `59/F`, a corroborated partial that counts once, and an old confirmation on a fresh snapshot that does not count.

### 6. Preserve missing measurements and present a valid interval (F06)

1. Replace clamping on the read path with range validation. Preserve zero and valid precision in the DTO. Round at rendering only. Validate new score, pillar and coverage writes with the same invariant.
2. Expose a nullable `provisionalRange` from validated endpoints when coverage is at least 80 and below 100 and the row’s evidence supports it. At publication derive `L` from observed weighted contributions and `U = L + 100 - coverage`. Apply a verified incident cap to both endpoints. Prefer decimal-capable endpoint storage when intervals preserve fractions. Do not derive an exact interval from rounded UI pillars.
3. Add the interval to the evidence disclosure. Test null, 0, `-1`, 101, non-finite values and the PRD’s `85% → [73, 88]` example. The current `101/-1` fixture should return nulls while the measured-zero fixture should continue returning zero.

```ts
function measuredPercent(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

const coverage = measuredPercent(snapshot.coverage);
const scoreTechnical = measuredPercent(snapshot.scoreTechnical);
```

### 7. Route every CLI failure to a clean exit (F07)

1. Keep `parseArgs` strict, request tokens, enforce exactly one positional and one `--approval`, and reject an empty or padded organization identifier. Validate JSON through F04’s schema before reading fields. Keep help independent of database setup.
2. Wrap the full entry in a single handled rejection. Emit a concise sanitized error with usage for argument errors. Preserve `process.exitCode` and `finally` disposal. Detect actual entry with `import.meta.main` on the tested Node baseline or an exact `pathToFileURL(resolve(argv[1]))` comparison for older supported Node versions.

```ts
const parsed = parseArgs({
  args,
  options,
  strict: true,
  allowPositionals: true,
  tokens: true,
});
const approvals = parsed.tokens.filter(
  (t) => t.kind === "option" && t.name === "approval",
);
if (
  !parsed.values.help &&
  (parsed.positionals.length !== 1 || approvals.length !== 1)
) {
  throw new CliUsageError(USAGE);
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatImporterError(error)); // controlled text, no raw approval bytes or stack
    process.exitCode = 1;
  });
}
```

Use child-process assertions for help, unknown flags, missing values, duplicate approval flags and JSON `null`. Assert documented output and no stack after failures.

### 8. Correct fleet contrast, tabular captions and loading announcements (F08)

1. Give selected buttons and the Tier 1 badge an explicit dark foreground paired with the primary surface. Reuse card foreground for small card metadata where the 7:1 contract applies. Keep the destructive count large or choose theme-specific red tokens that meet the documented target.
2. Apply `tabular-nums` to numeric card captions. Confirm the system font stack is the intended fallback and write the actual token source in DESIGN.md. Scope hover and focus checks to the actual card/tint surfaces.
3. Use a visually hidden `role="status"` message alongside hidden skeletons for both loading paths. Preserve the existing result count and error alerts. Mark decorative icons hidden to assistive tech explicitly where needed.

```tsx
<Button
  aria-pressed={selected}
  variant={selected ? "default" : "outline"}
  className="min-h-9 dark:aria-pressed:text-[oklch(13%_0_0)]"
>
  {label}
</Button>
<CardContent className="text-xs tabular-nums text-card-foreground">
  {gradedCount} of {totalDomains} properties graded
</CardContent>
<div>
  <span className="sr-only" role="status">Loading fleet overview</span>
  <SkeletonCard />
</div>
```

The example dark text is approximately 6.41:1 on the default dark primary fill. If the 7:1 target also applies to selected controls, pair that text with a lighter selected fill. Check hover and focus, plus selected and default styles in both themes. Add a local static/rendered accessibility fixture for announcements and table controls. Record breakpoint screenshots and edge evidence in their assigned stage.

### 9. Keep the overview read bounded without losing last good (F09)

1. Join active project scope in the member query. Put the organization and archived predicates in the left-join condition so unmapped/archived roster members still appear. Remove the large ID filter and repeated sorts where the same clock ordering has already been computed.
2. Combine run-item and snapshot reads through scoped roster joins. For a bounded history read, select per-member pointers to the latest admitted terminal attempt, current observation, last official and immediately preceding official. Derive stored pointers only at validated publication or implement equivalent windowed selection over validated facts. An arbitrary raw history limit would regress the existing “twenty partials” fixture.
3. Assert the design’s 2–3 query budget at the repository boundary on an 87-member fixture, with long partial history, out-of-order observations and invalid clocks. If the team chooses a different budget, measure locally and record the decision in DESIGN.md.

```ts
// First consolidation step. Keep the approved ID and validated live ID distinct.
const memberQuery = db
  .select({ member: fleetRosterMembers, liveProjectId: projects.id })
  .from(fleetRosterMembers)
  .leftJoin(
    projects,
    and(
      eq(projects.id, fleetRosterMembers.projectId),
      eq(projects.organizationId, organizationId),
      isNull(projects.archivedAt),
    ),
  )
  .where(eq(fleetRosterMembers.versionId, version.id));
```

### 10. Apply approved enrollment scope consistently (F10)

1. Filter exclusions before summary, count and scoring. Keep an explicit approved `exempt` member visible. Decide parked behavior from the approved site intent and encode it in persisted enrollment rather than deriving it from a nonexistent tier. Preserve the agreed unmapped-then-exempt precedence for displayed rows.
2. Add a test covering an excluded member with otherwise valid 100% evidence, an exempt mapped member and an unmapped member. Assert that the seven visible status counts add to the roster denominator and excluded evidence cannot change the median.

```ts
const includedMembers = members.filter((m) => m.enrollmentState !== "excluded");
for (const member of includedMembers) {
  // Evaluate only included members and derive the summary from those evaluations.
}
const totalDomains = includedMembers.length;
```

### 11. Tighten the typed score path and close the verification gaps (F11)

1. Make the production trend function take only admitted, typed official points. Keep its chronological ordering contract explicit. Remove casts and convenience re-exports from the service once their test callers import the actual owner. Narrow grade to `FleetGrade`, and the official grade to `Exclude<FleetGrade, "ungraded">`.
2. Keep useful positive and negative RPC unit tests. Add one request-level local test exercising the real authentication and error middleware with dummy identities, asserting the client error codes for no auth, wrong workspace and approval pending. Use real persisted fixture rows for score admission, duplicate keys and the float policy. Add CLI subprocess coverage from F04 and F07.
3. Rerun the focused suite, strict `tsc`, scoped prettier and `oxlint --type-aware`. Remove redundant mock-clearing and change fixture labels to say exactly which behavior they witness.

```ts
type OfficialPoint = NonNullable<ReturnType<typeof officialPoint>>;

function immediatelyPreviousOf(
  current: OfficialPoint,
  newestFirst: readonly OfficialPoint[],
): OfficialPoint | undefined {
  return newestFirst.find(
    (point) =>
      point.projectId === current.projectId &&
      point.observedAtMs < current.observedAtMs,
  );
}
```

### 12. Reconcile generated metadata with applied DDL (F12)

1. In disposable copies of both migration directories, generate from the predecessor to the fleet migration (`0055` SQLite and `0033` PostgreSQL). Verify the new metadata against the fleet SQL, including types, nullability, defaults, both comparison columns and both unique indexes.
2. If both fleet migrations are unapplied, regenerate the SQL, snapshot and journal entry together before releasing them. If either migration has been applied, preserve its SQL, tag and journal entry. Restore only the generated metadata that describes the DDL that actually ran, retaining the snapshot identity and predecessor linkage. Generate any subsequent schema changes as new migrations.
3. With the baseline reconciled and the corresponding schema unchanged, run generation on a scratch copy and require zero added migration files. Then generate a genuine small schema change in a scratch copy and replay it after both existing histories on local engines. Use the duplicate-index error reproduced in this audit as the SQLite regression witness.

```powershell
# Run on copied, corrected migration directories under the repo root.
pnpm exec drizzle-kit generate --dialect sqlite --schema ./src/db/d1/schema.ts --out ./scratch/fleet-sqlite --name stage1_probe
pnpm exec drizzle-kit generate --dialect postgresql --schema ./src/db/pg/schema.ts --out ./scratch/fleet-pg --name stage1_probe
# Assert the before/after list of migration filenames is identical in each copy.
```

The next Stage 1 gate requires the P1 cases to close through the normal entry points, both dialects to preserve the same persisted scoring contract, and the focused lint and test commands to pass. Stage 2 can assess deployed behavior independently.
