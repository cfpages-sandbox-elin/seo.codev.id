# OpenSEO Aggregated Fleet View (/onsite)

## Round 12 · Stage 1 architecture and code review · 2026-11-22

### Executive summary

**7.1 / 10.0 · Revision required for Stage 1 certification.** The read-only preview has a clear route → RPC → service → repository flow, tenant-scoped reads, dual-dialect schema registration, and a useful SQLite integration suite. Nine added service-level checks exposed ways for the dashboard to publish the wrong grade, replace a weekly score with diagnostic evidence, manufacture a comparable delta without a method key, or display evidence from the wrong attempt. These failures change what the operator sees and which rows rise in triage.

| Evaluation vector                     | Score / 10 | Basis                                                                                                                                                                                                                     |
| ------------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and contract soundness   |        7.4 | Clear server boundaries. Attempt, baseline and publication identities still overlap in the read model.                                                                                                                    |
| Persistence and dual-dialect parity   |        6.8 | Both migrations declare the Fleet columns and indexes. SQLite accepted duplicate logical identities. The importer has an incomplete approval contract.                                                                    |
| Edge cases and numerical robustness   |        5.5 | Correct median, null pillar handling, time parsing and wide-mismatch rejection. Reproduced failures in grade boundaries, series selection and clock admission.                                                            |
| Security and authorization            |        8.8 | Server-derived tenant, fail-closed flag and allowlist, and repository lineage checks. RPC tests substitute the middleware that establishes and masks the boundary.                                                        |
| Accessibility and design              |        7.1 | Semantic table, filter buttons, labelled links, native evidence disclosure and live result count. Several text colors fail the light-theme target, and measured zero coverage is indistinguishable from missing coverage. |
| Code quality, strict typing and tests |        6.8 | TypeScript and scoped lint passed. The focused suites are useful, but important cases remain uncovered and Fleet formatting and Knip checks fail.                                                                         |

The six vectors carry equal weight. Their arithmetic mean is 7.0667, rounded to 7.1. The score covers the local preview defined in [DESIGN.md](DESIGN.md#verification), including the PRD contracts it already claims to implement. The full PRD launch also requires features such as scheduling, history, export and remediation, which sit outside this preview. Live Access SSO, production bindings, responsive screenshots and edge p95 carry zero deduction.

**Reviewed snapshot.** Base Git SHA `0512c7423284a58283723a61cdea57b5b36b485e`. Git `HEAD` contains none of the named Fleet implementation files. The findings and score apply to the working-tree implementation above that base. The 37 changed or added review inputs, excluding historical review reports, have inventory SHA-256 `649eb897c3532655dd3824a83f2e0577e6d67a6562723dee5f7e12336a417bf2`. The aggregate hashes the UTF-8 stream of lexically sorted `path + NUL + raw-file SHA-256 + LF` records. The [PRD](C:/Users/THINKPAD/OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md) SHA-256 is `3301b3a6ab192d6ee332c8b134fd7e2a67f94b9448dcdbc4bb95e8f3827b469c`. Existing review scores were excluded from the rubric.

### Local verification

| Check                         | Result and evidence boundary                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four focused Vitest files     | **321 passed**. 284 structural schema tests, 17 SQLite integration cases, 15 domain cases and 5 mock-based RPC cases.                                                                                                                                                                                               |
| Added SQLite service checks   | **9 expected assertions failed against the current implementation**. The fixture used the existing app-shaped SQLite tables and the Fleet migration. All nine observations are described below. The disposable probe was removed.                                                                                   |
| Clean SQLite migration replay | **57 journal entries applied**, creating 10 Fleet tables and 14 named Fleet indexes. `PRAGMA foreign_key_check` returned zero rows after the duplicate-identity probes.                                                                                                                                             |
| PostgreSQL                    | Both SQL and schema definitions inspected. The parity suite checked Drizzle metadata. A local PostgreSQL server was unavailable, so PostgreSQL migration execution, provider round-trips and precision behavior remain unverified.                                                                                  |
| TypeScript and Oxlint         | `pnpm exec tsc --noEmit` passed. Scoped type-aware Oxlint passed on 19 Fleet files. Repository-wide lint exited 1 on two unchanged SERP cache files.                                                                                                                                                                |
| Scoped Prettier and Knip      | Prettier flagged `fleetCalculations.ts` and `FleetService.ts`. Knip reported eight Fleet schema exports through the CLI namespace and two unchanged SERP cache exports.                                                                                                                                             |
| Importer                      | `--help` printed usage and returned 0. The actual Node CLI with Wrangler against disposable D1 persisted 87 rows with a nonexistent `--approval` file. A changed digest exited 1 with `CONFLICT`. One exact replay printed success and then exited 3221226505 with a Windows libuv assertion (`UV_HANDLE_CLOSING`). |
| Full Vitest                   | **1,679 passed, 8 failed** across **228 passing and 5 failing files**. Failures were in preview Access tooling, Google test teardown and SAM skill frontmatter. Those paths are unchanged in the Fleet working tree. The full run was supplementary and the score uses Fleet-specific evidence.                     |

The 284 parity cases validate matching application table sets, column shape and default presence, key metadata and check names. They do not exercise numeric precision, non-unique indexes, SQL default values or database write behavior. The application suite passes in Node with the Start and Cloudflare plugins disabled, per [vite.config.ts](vite.config.ts#L12-L29).

## Detailed findings

### P0 · Blockers

None confirmed for the read-only preview. The P1 findings block Stage 1 certification.

### P1 · High

**P1-1. Reconciliation can publish an impossible headline grade.** The calculator rounds the weighted result, accepts a full-point discrepancy, checks the grade against the rounded result and displays the stored integer. The PRD floors the precise capped result and derives the grade from that same headline. A row with six 80-point pillars, stored 79 and grade B became **79/B**. A row with six 89.9-point pillars, stored 90 and grade A became **90/A**. An unsupported rubric with otherwise consistent pillars also became official because the read model drops rubric identity and always applies the v1 weights. These rows enter the median, grade distribution and prior-point selection. The second arithmetic predicate repeats the rounding and tolerance, and both schema definitions store the score as an integer. [fleetCalculations.ts](src/server/features/fleet/services/fleetCalculations.ts#L123-L157) · [fleetCalculations.ts](src/server/features/fleet/services/fleetCalculations.ts#L177-L215) · [FleetRepository.ts](src/server/features/fleet/repositories/FleetRepository.ts#L275-L302) · [SQLite score](src/db/fleet.schema.ts#L191-L210) · [Postgres score](src/db/pg/fleet.schema.ts#L183-L198)

**P1-2. Diagnostic and unidentified snapshots can enter the weekly baseline.** A newer completed diagnostic replaced the weekly 85 with 95 in both the headline and last-good value. The service admits observations by project and parent attempt status alone. The trend function treats a missing series as a wildcard, and the repository replaces a missing comparability key with the parent rubric string. Two null-series, null-method rows returned **+6**. Matching rubric alone establishes none of panel, applicability, collector, or profile identity. The existing matrix compares a missing current key with an explicit prior key, so it misses the both-missing case. [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L159-L226) · [FleetRepository.ts](src/server/features/fleet/repositories/FleetRepository.ts#L296-L302) · [fleetCalculations.ts](src/server/features/fleet/services/fleetCalculations.ts#L291-L352) · [existing comparison cases](scripts/fleet-overview.integration.test.ts#L254-L281)

**P1-3. The completion-time cutoff leaves linked snapshots eligible and partial rows borrow old evidence.** A completed attempt dated tomorrow with an observed snapshot dated today bypassed the terminal overlay cutoff and supplied **91** as both current and last good, displacing a valid **85**. A future observation attached to an otherwise completed attempt took the newest position and turned **85 / fresh graded** into **no score / stale**. For a fresh partial with no snapshot, `?? latestObserved` republished the prior snapshot’s **100% coverage**, pillar **85** and timestamp as current partial evidence. A stale row with a valid historical pair also emitted **+6** in the headline Trend column while its headline score was empty. Observation order and completion order are distinct selection rules. Admission must first validate both clocks and the attempt/snapshot relationship. [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L134-L238) · [fleetCalculations.ts](src/server/features/fleet/services/fleetCalculations.ts#L258-L288) · [trend consumers](src/client/features/fleet/FleetMatrixRow.tsx#L301-L323)

**P1-4. The importer does not bind approval to the roster it publishes.** The actual local Node CLI accepted a nonexistent `--approval <file>` and persisted 87 members, all imports credit a hardcoded approver, and a missing organization argument becomes `default`. The manifest has 87 unique hosts, but approval and mapping are separate properties. Both import paths infer mapping from current projects, resolve collisions by order, and persist all rows as active with empty aliases. The exact tag and SHA-256 checks verify the normalized manifest payload. They do not establish who approved it or bind the resolved project assignments. The two write implementations also differ on replay of an empty digest and on recovery after a competing insert. The registered suites exercise neither production write path. [importer](scripts/import-fleet-roster.ts#L17-L59) · [import writes](scripts/import-fleet-roster.ts#L63-L139) · [repository seed](src/server/features/fleet/repositories/FleetRepository.ts#L72-L170) · [manifest normalization](src/server/features/fleet/data/fleetManifest.ts#L20-L46)

### P2 · Medium

**P2-1. Database keys allow repeated logical identities on both dialects.** The roster enforces version/host uniqueness and the run-item table enforces run/member uniqueness. Neither roster table enforces one non-null project per version, and neither snapshot table enforces one row per run item and series. With foreign keys enabled, migrated SQLite accepted two hosts assigned to one project in the same roster and two weekly points for the same item and series. The PostgreSQL SQL declares the same omission. Duplicate mappings can count one project twice. Duplicate points make reads depend on timestamp and ID tie-breaks. The current read-side lineage checks usefully reject foreign run and roster associations, but cannot distinguish two otherwise valid rows for one logical publication. [SQLite keys](src/db/fleet.schema.ts#L95-L101) · [SQLite snapshot indexes](src/db/fleet.schema.ts#L221-L227) · [Postgres keys](src/db/pg/fleet.schema.ts#L89-L95) · [Postgres snapshot indexes](src/db/pg/fleet.schema.ts#L207-L213)

**P2-2. The row contract conflates unknown and measured zero, and calls stale flags current.** The service returns zero coverage when evidence is absent. Both render sites hide zero for an ungraded row. A valid zero-coverage observation and an absent observation therefore look and sort alike, against the explicit design contract. A stale capped snapshot also increments the metric described as “Domains with a current critical flag.” Expired evidence can lead triage even when the app has no current confirmation. The preview reads persisted cap flags. It has no independent open-incident ledger to resolve this distinction. [DESIGN.md](DESIGN.md#L112-L115) · [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L97-L125) · [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L229-L262) · [coverage rendering](src/client/features/fleet/FleetMatrixRow.tsx#L325-L329) · [current flags label](src/client/features/fleet/FleetMetricCards.tsx#L45-L69)

**P2-3. Light-theme score, grade and delta text falls below the contrast target.** Status badge text uses the card foreground. The score, grade, delta, critical flag and preview badge still use saturated `*-500` text. From the installed Tailwind tokens against the white card, approximate base contrasts include **2.15:1** for amber-500, **2.46:1** for emerald-500 and **3.76:1** for rose-500. The values are below the 4.5:1 AA target for normal-sized text before the same-color background tints. The source does provide textual labels, a proper table caption and `aria-sort` on the sorted header. The native six-pillar disclosure works in the shared row, which remains a horizontally scrollable table on mobile. [app.css](src/client/styles/app.css#L67-L77) · [row score, grade and trend](src/client/features/fleet/FleetMatrixRow.tsx#L233-L323) · [preview badge](src/client/features/fleet/FleetOverviewView.tsx#L60-L65) · [grade distribution](src/client/features/fleet/FleetMetricCards.tsx#L74-L96)

**P2-4. RPC coverage stops before the real authorization and error boundary.** The RPC uses global auth and error-masking middleware, verifies the active org and configured allowlist, validates the expected org and checks `fleet:view`. Source inspection found no cross-tenant read path in the preview. The five RPC tests replace both `createServerFn` and `requireAuthenticatedContext`. The success labelled “reader” runs as `owner` and the disabled-or-absent case only sends `false`. The suite would not catch middleware removal or regressions in validation and wire error masking. The delegated Cloudflare Access mode intentionally gives verified shared-workspace users owner context. Keep that explicitly documented when interpreting role coverage. [fleet.ts](src/serverFunctions/fleet.ts#L16-L52) · [fleet.test.ts](src/serverFunctions/fleet.test.ts#L7-L100) · [global middleware](src/start.ts#L1-L11) · [shared workspace context](src/middleware/ensure-user/delegated.ts#L80-L96)

**P2-5. The read path exceeds its source query budget and loads every historical row.** The active-project lookup plus run-item and snapshot queries per 50-member chunk yields **7 queries** for a fully mapped 87-member roster, versus the design’s fixed 2–3. The query count is acceptable as a small bounded preview cost. Work and memory grow with the entire roster history, however. The app fetches full snapshot records, plus fields such as lease tokens and error details that the service never displays. It sorts complete histories twice and revalidates official points in separate passes. Apply any history-window reduction only after preserving the independent last-good requirement and normalizing time formats before database ordering. [DESIGN.md](DESIGN.md#L101-L105) · [FleetRepository.ts](src/server/features/fleet/repositories/FleetRepository.ts#L185-L273) · [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L139-L174) · [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L307-L331)

**P2-6. Fleet code fails the checkout’s static acceptance gates.** Two new files fail Prettier. The CLI’s namespace import leaves Knip treating eight Fleet exports as unused properties. Those definitions also serve schema discovery and both dialect barrels. Mark the actual schema module as an entry in the same way the repository handles its other reflection- or barrel-consumed schema, and use named CLI imports. Keep unrelated SERP cache failures separate from the Fleet delta. [knip.jsonc](knip.jsonc#L10-L20) · [importer imports](scripts/import-fleet-roster.ts#L5-L15) · [CI check](package.json)

### P3 · Low

**P3-1. Current documentation mixes shipped behavior, roadmap and certification claims.** `CODEBASE.md` lists three absent RPCs and three component names that do not describe the current preview. `DESIGN.md` identifies the preview correctly, then marks it certified while the local static and behavior checks above fail. Its page contract also attributes `aria-sort` to buttons and promises a row-reorder animation. The source places `aria-sort` on the enclosing column header, which is the correct semantic element, and implements immediate reorder. Update the current-state text and retain the larger features as roadmap items. [CODEBASE.md](CODEBASE.md#L228-L240) · [DESIGN.md](DESIGN.md#L170-L186) · [DESIGN.md](DESIGN.md#L211-L218) · [FleetMatrixTable.tsx](src/client/features/fleet/FleetMatrixTable.tsx#L37-L68)

## Design principle assessment

| Principle              | Stage 1 source assessment                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fitts’s Law            | Filter, sort, disclosure and audit controls declare 36px minimum heights under the default spacing scale. The reset uses an inline button without equivalent sizing. |
| Visual Hierarchy       | Title and four fleet metrics precede the filters and matrix.                                                                                                         |
| Von Restorff Effect    | The incident count has a distinct treatment when positive. Freshness and color defects are recorded above.                                                           |
| Object Constancy       | App shell and column layout stay stable. Stable member keys retain the disclosure state when rows reorder.                                                           |
| Snapping               | Inapplicable. The matrix has no drag, resize or snapping interaction.                                                                                                |
| Motion Blur            | Inapplicable. The view has no fast custom motion.                                                                                                                    |
| Natural Mapping        | Column controls change the ordering they describe. Arrow direction and `aria-sort` agree.                                                                            |
| Tabular Figures        | Headline metrics and key numerical columns use `tabular-nums`. Grade-distribution chips omit it.                                                                     |
| Animate Only the Delta | The source reorders rows immediately. Existing color transitions attach to the affected controls and row states.                                                     |
| Inertia                | Native scrolling owns momentum. The view has no custom drag or inertial behavior.                                                                                    |
| Multimodal Feedback    | Filter selection combines visible state with `aria-pressed`. Result counts have a live status region.                                                                |
| Visual Cues            | Links and disclosure provide focus treatment, and loading, approval pending, authorization denial, error and no-match states have distinct markup.                   |
| Skeuomorphism          | Inapplicable. The app uses standard table, disclosure and button affordances.                                                                                        |

## Implementation pointers and acceptance checks

Use the shipped SQLite integration fixture for the service behavior oracles. It already exposes `attempt`, `row` and the local SQL client. Add the asserted cases at the owner boundary and keep the migration and service gates distinct.

### P1-1 · Use one precise reconciliation path

1. Carry `fleetRuns.rubricVersion` as a separate, typed field through the joined repository projection. Reject unknown rubrics at the read and publication boundaries.
2. Compute the raw uncapped v1 weighted score once from the six validated finite values. Apply the cap once. Make classification, median inclusion, headline grade and baseline selection all consume the same result. Remove `isGradedReconciled` and the duplicate rounding. For official points persist the raw value as SQLite `real` and PostgreSQL `doublePrecision`. Use a consistent numeric representation for pillars and the authoritative raw result in both dialects.
3. Migrate existing integers by validating or recomputing against retained evidence. Keep a row ungraded when there is insufficient evidence to reconcile it. Preserve raw precision and derive the headline integer in one place.

```ts
// Inside officialPoint after attempt, rubric, coverage and pillar validation.
const rawScore = snap.hasIncidentCap ? Math.min(59, uncapped) : uncapped;
const score = Math.floor(rawScore);
const grade = gradeFor(score);
if (
  snap.score === null ||
  !Number.isFinite(snap.score) ||
  Math.abs(snap.score - rawScore) > 1e-9 ||
  Math.floor(snap.score) !== score ||
  snap.grade !== grade
) {
  return null;
}
return { ...snap, rawScore, score, grade, observedAtMs };
```

Use a tolerance only for raw-value serialization. Fix the producer’s numerical scale and add mixed-pillar fixtures that land exactly on grade boundaries to verify the chosen arithmetic at those boundaries. Keep display and trend differences in headline integers. Test each boundary and a point just below it, including 89.9/B, a valid capped 59/F, all-zero 0/F, a missing pillar, the persisted 79/B mismatch, and an unsupported rubric. The grade must equal `gradeFor(displayScore)` for every official result.

### P1-2 · Persist evidence identity and select the weekly series explicitly

1. Project `seriesKey`, `comparabilityKey` and rubric identity independently. Remove the rubric fallback. Validate producer keys and bind the comparability key to canonical identity, policy/applicability, panel, collector and profile before publication. Backfill only when the retained evidence establishes those fields.
2. Record series on the attempt, or on its parent run if the run is constrained to one series. This lets a failed or partial diagnostic remain visible in its own context without masking the weekly disposition. Require actual baseline identity for the official headline, last-good and comparison lists. Keep unidentified legacy evidence outside comparable history.
3. Select the immediately preceding official weekly point before checking its comparability. If it is incompatible, return null even when an older point has a match. Keep the 21-day bound. Surface the reason when the preview starts showing comparison details.

```ts
const weekly = rankedPoints.filter(
  (point) => point.seriesKey === "weekly-baseline",
);
const prior = weekly.find((point) => point.observedAtMs < current.observedAtMs);
if (
  current.seriesKey !== "weekly-baseline" ||
  !prior ||
  current.rubricVersion !== prior.rubricVersion ||
  !current.comparabilityKey?.trim() ||
  current.comparabilityKey !== prior.comparabilityKey ||
  current.observedAtMs - prior.observedAtMs > COMPARABLE_BASELINE_WINDOW_MS
)
  return null;
return current.score - prior.score;
```

Add separate assertions for a newer diagnostic, null or blank identity on both points, equal method keys on different rubrics, a changed immediate prior followed by an older match, a same-method zero delta, and a gap greater than 21 days.

### P1-3 · Admit both clocks and keep attempt evidence separate

1. After tenant, roster, project and series scoping, parse each terminal item once. Use only admitted terminal items when joining observations. Parse each observation before ordering, including rows used for last good. Treat future or invalid timestamps as inadmissible data. For an item whose completion means publication completed, require the observation time to be at or before completion.
2. Keep independently sorted terminal attempts and observations. When the latest terminal attempt is partial, select its own observation or null. Use that attempt’s completion time for the age of a snapshot-less partial. Only the historical field should carry the last valid official score and its date.
3. Derive the headline delta only when the displayed row has a fresh graded headline. If a future design displays historical deltas, label that separate value and exclude it from current triage.

```ts
function admittedCompletion(value: string | null, now: number) {
  const ms = parseUtcTimestampMs(value);
  return Number.isFinite(ms) && ms <= now ? ms : null;
}

const observations = memberSnaps.flatMap((snap) => {
  const parent = admittedItemById.get(snap.runItemId);
  const observedAtMs = admittedCompletion(snap.observedAt, now);
  if (
    parent === undefined ||
    parent.item.status === "failed" ||
    observedAtMs === null ||
    observedAtMs > parent.completedAtMs
  )
    return [];
  return [{ snap, observedAtMs }];
});
// Sort observations by observedAtMs and a stable ID tie-break first.
const current =
  latestAttempt?.status === "partial"
    ? (observations.find(({ snap }) => snap.runItemId === latestAttempt.id)
        ?.snap ?? null)
    : (observations[0]?.snap ?? null);
const trendDelta =
  disposition === "fresh_graded"
    ? computeTrendDelta(/* admitted points */)
    : null;
```

Use the existing clock fixture at noon. Change a linked item’s completion to tomorrow and assert the baseline remains 85. Repeat for an observation dated tomorrow. Assert new snapshot-less partial evidence has no current coverage, pillar or timestamp, and historical evidence remains dated. Assert a stale row has no headline delta. Retain the existing delayed-completion test to prove the two orders stay independent.

### P1-4 · Make roster approval and replay one write contract

1. Parse arguments before booting Wrangler. Require exactly one organization and the advertised approval file. A missing or malformed file, unrecognized option, bad organization, or mismatch must fail with zero writes. Keep the help path dependency-light. Name the local Wrangler target explicitly so the operator knows which database will change.
2. Use the repository’s Zod package to validate the approval document. Freeze the version tag, organization, approver and canonical roster payload. Let each manifest entry state the exact approved project ID or null, aliases and enrollment disposition. Validate unique canonical hosts and non-null project assignments, and verify each approved project is active and belongs to the same tenant. Reject ambiguous legacy inference. Treat the approval file as a trusted operator artifact and document its provenance.
3. Have one writer produce the version and member writes. Remove the unused Worker seed method if the CLI remains the sole writer. Hash a deterministic approved payload that includes project IDs, aliases and enrollments. On initial or post-race exact-tag lookup, return only a matching digest. Keep publish atomic. A different digest should yield a stable conflict and keep the original version.
4. After `dispose()` completes, let Node exit naturally on success and set `process.exitCode = 1` on failure. This removes the forced shutdown during replay. Repeat the exact replay on Windows to determine whether the libuv assertion is resolved.

```ts
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  args,
  allowPositionals: true,
  strict: true,
  options: {
    help: { type: "boolean", short: "h" },
    approval: { type: "string" },
  },
});
// Handle help before the following guard or any binding setup.
if (positionals.length !== 1 || !values.approval) throw new Error(USAGE);
const approval = approvalSchema.parse(
  JSON.parse(await readFile(values.approval, "utf8")),
);
if (approval.organizationId !== positionals[0])
  throw new Error("Organization mismatch");
// Validate org and project assignments, then hash and atomically publish.
```

Run the real CLI over a freshly migrated disposable D1 fixture. Capture approval absent, file missing, malformed, wrong org, valid 87-row import, two simultaneous same-digest imports, different-digest replay, and an invalid member halfway through. Assert version and member counts after each run.

### P2-1 · Enforce the logical keys in both migrations

1. Add the same unique indexes in both Drizzle definitions. Standard SQLite and PostgreSQL unique indexes permit multiple null project IDs. Bind official snapshots to a non-null series. Keep the run rubric immutable if it remains owned by the parent, so the run-item ID already identifies rubric and tenant.
2. Before upgrading a database with Fleet data, query duplicates and quarantine or reconcile with retained source identity. Regenerate both migrations. Add DDL-backed tests for duplicate rejection and multiple null assignments, and a PostgreSQL behavioral replay at Stage 1.

```sql
CREATE UNIQUE INDEX fleet_roster_members_version_project_idx
  ON fleet_roster_members (version_id, project_id);
CREATE UNIQUE INDEX fleet_snapshots_item_series_idx
  ON fleet_snapshots (run_item_id, series_key);
```

Assert one published snapshot for a run item and series after an exact replay. Assert a conflicting duplicate cannot affect the aggregate. Extend Fleet-specific parity to compare ordered non-unique read indexes and add a behavioral check wherever equivalent defaults or SQL constraints matter.

### P2-2 · Represent evidence absence and incident freshness explicitly

1. Change `FleetDomainSummary.coverage` to `number | null`, propagate null when evidence is unavailable, and retain measured zero. Validate finite percentages inside the domain before serialization. Do the same for individual pillar values.
2. Use the same formatter in the matrix and disclosure, and let the existing sort comparator put null last. Preserve historical flags separately if the UI needs them. For the “current” metric and triage, count only confirmed, admitted evidence still in its freshness window. A real unresolved-incident count would require explicit incident state.

```ts
const coverage =
  hasScores && currentSnapshot && Number.isFinite(currentSnapshot.coverage)
    ? currentSnapshot.coverage
    : null;
const currentFlag =
  (disposition === "fresh_graded" || disposition === "fresh_partial") &&
  Boolean(currentSnapshot?.hasIncidentCap);
const coverageLabel = coverage === null ? "—" : `${coverage}%`;
```

Assert absent and observed-zero coverage render distinctly. Assert a stale cap remains historical and never increments the metric labelled current. Assert a fresh confirmed partial still brings its critical flag without receiving an official grade.

### P2-3 · Put semantic colors on decoration

1. Use `text-card-foreground` for grade, critical and score text on card surfaces. Keep semantic color in dots, icon accents or tints with redundant text. Apply the same scheme to metric badges, trend labels and the preview badge. Use `tabular-nums` on distribution counts. Give the reset action the same focus and target-size treatment as the shared buttons.
2. Verify both themes against the actual text backgrounds, including tinted badges and hover. Add a local rendered-DOM check for the disclosure name, sort header state, reset and visible focus. Keep live and responsive screenshots in Stage 2.

```tsx
<Badge variant="outline" className="bg-amber-500/10 text-card-foreground">
  <span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />C
</Badge>
```

### P2-4 · Add a middleware-backed Fleet RPC test

1. Keep the existing handler policy tests, set the allowed case to `member` and add explicit cases for missing flag and missing allowlist. Assert denial leaves the service uncalled.
2. For the transport check, run the TanStack Start server-function request through a local fixture using the generated app. Keep `createServerFn`, `requireAuthenticatedContext` and `errorHandlingMiddleware` real. Stub `resolveUserContextFromHeaders` for anonymous, different organization, actual member and denied role. Stub only the downstream service for success/failure. Drive the request through the actual page query wrapper so the fixture uses the framework’s own RPC encoding.
3. Assert on the client-facing code or payload and the service reachability. The normal `getFleetOverview` caller must receive a masked response when repository errors include internal details.

```ts
// In the local Start fixture, call the client's imported server-function stub.
resolveUserContextFromHeadersMock.mockRejectedValueOnce(
  new AppError("UNAUTHENTICATED"),
);
await expect(callFleetThroughStart()).rejects.toThrow("UNAUTHENTICATED");
expect(getOverviewMock).not.toHaveBeenCalled();

resolveUserContextFromHeadersMock.mockResolvedValueOnce(memberContext);
getOverviewMock.mockRejectedValueOnce(new Error("private SQL detail"));
await expect(callFleetThroughStart()).rejects.toThrow(/^INTERNAL_ERROR$/);
```

Add malformed input and unauthorized org checks. Confirm the allowed request actually reaches `getOverview` with the resolved organization. Keep Google SSO and the live perimeter outside this fixture.

### P2-5 · Align the read cost with the design

1. Record the accurate seven-query shape for the current 87-domain preview. Project the run-item fields used by the service and drop the database text sort if the application still owns mixed-format sorting. Parse and sort each admissible history once and reuse the validated observations for disposition, last good and trend.
2. If the read must meet the fixed 2–3 query contract, join roster and active-project validation and normalize stored clocks. Index the per-member latest terminal and observation lookups. Return the latest admitted terminal and weekly observation, last official, and immediately preceding official comparison point. Preserve access to an arbitrarily old last-good point. A fixed count, arbitrary cutoff, or text-ordered limit cannot safely replace that search.
3. Test mixed-format upgrade data, at least 20 intervening partials, and a populated 87-member fixture. Count actual statements through the database adapter and assert that projection omits evidence blobs and diagnostics the overview never consumes.

```ts
const attempts = await db
  .select({
    id: fleetRunItems.id,
    memberId: fleetRunItems.memberId,
    projectId: fleetRunItems.projectId,
    status: fleetRunItems.status,
    completedAt: fleetRunItems.completedAt,
    rubricVersion: fleetRuns.rubricVersion,
  })
  .from(fleetRunItems)
  .innerJoin(fleetRuns, authorizedRunAndRoster)
  .where(inArray(fleetRunItems.memberId, chunk));
```

### P2-6 · Fix and rerun the static gates

1. Replace namespace imports in the CLI with the named roster tables and `projects`. If Knip still flags schema-discovery exports, add the exact SQLite schema entry with the existing explanation for reflection-consumed schemas. Keep the migration and type exports required for drizzle-kit.
2. Format the two files. Re-run scoped formatting, Knip, `tsc --noEmit` and scoped type-aware Oxlint. Report separately any repository baseline failures from unrelated paths.

```ts
import {
  fleetRosterMembers,
  fleetRosterVersions,
} from "../src/db/fleet.schema";
import { projects } from "../src/db/app.schema";
```

```powershell
pnpm exec prettier --write src/server/features/fleet/services/fleetCalculations.ts src/server/features/fleet/services/FleetService.ts
pnpm knip
pnpm exec tsc --noEmit
```

### P3-1 · Correct the current-state contract

1. In `CODEBASE.md`, list the single implemented RPC and the actual overview components. Move proposed handlers and UI files into the roadmap. Record computed query count in `DESIGN.md`.
2. Update the accessibility and motion descriptions to the implementation. Replace the certification line with the exact reviewed source and local acceptance state once its checks pass.

```md
- Current preview: /onsite → FleetOverviewView → getFleetOverview.
- Table: aria-sort belongs to the currently sorted column header.
- Motion: sorting changes row order immediately. Native disclosure toggles evidence.
- Roadmap: domain history, comparisons, run admission, export and remediation.
```

### Stage 1 acceptance order

1. Consolidate numerical reconciliation, explicit weekly identity and both-clock admission. Re-run the failing service probes as checked-in regression cases.
2. Bind roster approval, index logical keys in both engines, and demonstrate the real local CLI, SQLite and PostgreSQL behavior. Run the RPC middleware check in the local app fixture.
3. Re-run the four focused suites and static gates, validate the contrast and evidence states locally, and refresh the current-state docs. Evaluate the updated implementation against the same six vectors and the same Stage 1 boundary.
