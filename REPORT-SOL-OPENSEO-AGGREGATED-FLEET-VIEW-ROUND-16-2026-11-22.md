# OpenSEO Aggregated Fleet View · Stage 1 code review · Round 16

**Overall score: 7.35 / 10.00. Five P1 findings, four P2 findings, and no P0 findings identified in the reviewed source.** The private read-only preview has a sound application structure and a working SQLite read path. The remaining P1 defects affect the grade, alert, trend, or initial render an operator relies on for triage.

Reviewed on 22 November 2026 against the local working tree based on `0512c7423284a58283723a61cdea57b5b36b485e`, including the modified and untracked implementation. The reviewed inputs are the 43 Fleet worktree files plus the PRD. Their SHA-256 binding is `236079ad2f57f97cc6bb209cdfbfc280a7c3171e59d3551a59a5832979b64541`, computed from sorted path and raw-file SHA-256 pairs separated by LF.

The valuation covers the private, read-only preview specified in [DESIGN.md](DESIGN.md#verification), the applicable overview, identity, scoring, and access rules in the [Fleet PRD](<C:/Users/THINKPAD/OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md>), and the implementation inventory in [CODEBASE.md](CODEBASE.md#7-aggregated-fleet-view-onsite-implementation-roadmap). Lower quartile, fixed-cohort movement, rule-level drivers, export, baseline publication, and the full drill-down and remediation flows are still product rollout work. The preview supplies roster import, snapshot read and reconciliation, and audit deep links. Stage 2 has **zero weight and zero deduction**. Live Google SSO, deployed bindings, browser screenshots against the deployment, and edge p95 are Stage 2 checks.

## Valuation

The request left the weights open. I used 25% for numerical and evidence correctness, 20% each for architecture and persistence, 15% for security, and 10% each for UX and engineering quality. A 10 requires the reviewed preview contract to hold at its public boundaries with proportionate regression evidence. P1 denotes a material incorrect result or failure of an explicit preview contract. P2 denotes a bounded integrity, usability, or operational limitation. Each defect is primarily charged to one vector. Repository-wide failures outside Fleet are reported separately and carry no feature deduction.

| Vector | Weight | Score / 10 | Weighted points | Stage 1 judgment |
| --- | ---: | ---: | ---: | --- |
| Architecture and contract soundness | 20% | 7.0 | 1.400 | Clear route → authenticated RPC → service → repository. The DTO separates current, last-good, and latest attempt data. Current selection and host mapping still misrepresent valid operator states. Cold SSR omits the view. F01, F05, F06. |
| Persistence and dual-dialect parity | 20% | 7.8 | 1.560 | Both journals replay, fleet structures match, float64 is aligned, and the four-query path uses join indexes. The schema permits invalid lineage and the overview materializes roster history. F07. |
| Edge cases and numerical robustness | 25% | 6.1 | 1.525 | Six-pillar, 100% coverage grading, fresh-only median, expiry, and immediately preceding official comparison rules are good foundations. Reproduced cap, provenance, grade floor, and interval defects remain. F02–F04. |
| Security and authorization | 15% | 8.0 | 1.200 | Fail-closed flag and org entitlement, request-derived organization, role gate, and Access JWT validation in source. The roster digest covers manifest metadata while project bindings remain apply-time choices. F08. |
| Accessibility and design contract | 10% | 8.6 | 0.860 | Native table, named keyboard scroller, labelled links, sort state, pressed filters, live result count, and reduced-motion spinner. Source-token ratios for the checked pairs meet AA. Evidence dates and row-header semantics need correction. F09. |
| Code quality, strict typing, and tests | 10% | 8.0 | 0.800 | Strict TypeScript, clean focused Oxlint, coherent module boundaries, and 368 focused passes. The SSR and importer success paths lack permanent end-to-end tests, and the parity suite checks schema shapes more thoroughly than behavior. |
| **Overall** | **100%** | **7.35** | **7.345** | Exact decimal weighted sum rounded to two places. |

## Verification

| Check | Fresh result |
| --- | --- |
| `pnpm types:check` | **Pass.** Root `tsconfig.json` enables `strict`. |
| Fleet and changed wiring, type-aware Oxlint | **0 warnings, 0 errors**, 30 TypeScript and TSX files, including the five focused test files. |
| `pnpm lint` | **0 warnings, 2 errors**, exit 1. Unused `vi` in [serpCache.test.ts](src/custom/serpCache.test.ts#L1) and an unsafe cache-result assertion in [serpCache.ts](src/custom/serpCache.ts#L64). Both files match HEAD and are outside the Fleet change set. |
| Focused Vitest | **368/368 in five files**, including the full shared parity suite. Application tests include real libSQL execution of the Fleet migration and the production repository/service. RPC tests mock Start and authentication middleware. Importer tests cover parsing and rejection before DB apply. |
| `pnpm test` | **228/234 files passed. 1,724/1,734 tests passed.** Ten test failures and two additional failed-suite teardowns outside Fleet. The run reported preview Access script assertions, child-process timeouts in string retention, Google DB temp-directory cleanup errors, and SAM skill frontmatter parsing. Baseline causality was left open where it was unverified. |
| Local SQLite | **57 migrations** replayed on SQLite 3.50.4 with foreign keys enabled and an empty `foreign_key_check`. Fleet migration contains 10 tables and 16 named secondary indexes. |
| Local PostgreSQL | **35 migrations** replayed on disposable PGlite PostgreSQL 18.7. The Fleet migration created 10 tables and 16 named secondary indexes. A separate Fleet SQL check preserved `89.999999996::double precision`, allowed multiple unmapped members, and rejected a duplicate host within a roster. This exercises the SQL engine and migration, while the permanent repository/service integration tests use SQLite. |
| Drizzle metadata | `drizzle-kit check` passed for both `drizzle/sqlite.config.ts` and `drizzle/pg.config.ts`. |
| Design validator | **Pass**, one page contract and 13/13 required principles. The validator checks the document structure. |
| Independent probes | Six SQLite-backed behavior witnesses, an installed-router SSR render witness, a Node Jakarta timezone witness, and a SQLite query plan. The disposable test files assert the observed behavior and were removed after execution. |
| OCR coverage | Workspace preview selected 36 files. All 36 were reviewed or mechanically cross-checked. Of its 12 default exclusions, the five tests and two design/architecture docs were reviewed directly. The other five are earlier review reports outside the implementation scope. The external PRD was read separately. OCR supplied deterministic selection and rules. The findings and score came from this review. |

```powershell
pnpm exec vitest run src/db/schema-parity.test.ts src/server/features/fleet/services/FleetService.test.ts src/serverFunctions/fleet.test.ts scripts/import-fleet-roster.test.ts scripts/fleet-overview.integration.test.ts
```

The manifest contains **87 distinct normalized hostnames**. That establishes unique source entries. Approved membership, ownership exceptions, and actual project mappings require the corresponding approval evidence. The code applies a read-only preview policy on top of whatever approved version and admitted observations are stored.

In Access mode, app source verifies the assertion signature against the team JWKS and checks the issuer and application audience before resolving identity. Every Access-admitted user receives the shared workspace's implicit owner role. Tier 1 owner-only admission therefore depends on the Access policy. In hosted mode, the active workspace hint is checked against the live member row. The Fleet RPC independently requires its feature flag, the configured organization, permitted role, and the optional expected-org match. Start applies its server-function CSRF middleware on the RPC path. The Fleet handler suite exercises those entitlement checks with injected context. [Access resolver](src/middleware/ensure-user/cloudflareAccess.ts) · [Delegated workspace role](src/middleware/ensure-user/delegated.ts#L62) · [Hosted membership](src/middleware/ensure-user/hosted.ts#L30) · [Start middleware](src/start.ts) · [Fleet RPC](src/serverFunctions/fleet.ts#L16)

## Findings

### P1

**F01 · A completed attempt with no admitted point can leave the previous grade looking current.** The selector binds a partial attempt to its own observation. A completed attempt takes the first surviving observation across all attempts. With an earlier **85/B** and a newer weekly item marked completed with no snapshot, the service reports **fresh graded 85/B**, sets the latest attempt to the newer run, and leaves the observation at the older run. That grade feeds the fleet median and distribution. A completed attempt whose point was dropped at admission has the same shape. Keep late *valid* completions ordered by observation time, and represent a completed envelope with no usable evidence explicitly. [FleetService.ts:117](src/server/features/fleet/services/FleetService.ts#L117) · [fleetObservations.ts:57](src/server/features/fleet/services/fleetObservations.ts#L57) · [Existing late-completion fixture](scripts/fleet-overview.integration.test.ts#L355)

**F02 · The incident parser can cap a site on undated or ineligible evidence.** Missing corroboration time inherits primary time, so a dated primary and an undated corroborator pass the freshness test. The eligible kind set also includes `security_challenge`, although the PRD excludes provider blocking alone from essential caps. In the SQLite witness, six 90-point pillars, a stored 59, and a `security_challenge` envelope with an undated corroborator yielded **59/F and a critical flag**. The same parser governs historical caps and current flags. The existing 10-day freshness guard and comparison against observation time should remain. Each observation needs its own time, eligible outcome, and evidence of independence and intent. [fleetEvidence.ts:18](src/server/features/fleet/services/fleetEvidence.ts#L18) · [fleetEvidence.ts:153](src/server/features/fleet/services/fleetEvidence.ts#L153) · [fleetCalculations.ts:208](src/server/features/fleet/services/fleetCalculations.ts#L208) · [FleetService.ts:225](src/server/features/fleet/services/FleetService.ts#L225)

**F03 · A syntactically valid digest can publish a spurious trend.** Two valid observations with the same opaque 64-character hex value produce **+4** in the SQLite witness. The read path checks format and equality. The generator permits absent panel, applicability, collector, metric, lab, and source inputs through shared defaults, and its only callers today are tests. There is no source-side publisher or persisted identity payload against which the overview can verify the key. A current grade can remain usable with its own valid evidence while the trend is unavailable. [fleetEvidence.ts:213](src/server/features/fleet/services/fleetEvidence.ts#L213) · [fleetEvidence.ts:244](src/server/features/fleet/services/fleetEvidence.ts#L244) · [fleetCalculations.ts:411](src/server/features/fleet/services/fleetCalculations.ts#L411)

**F04 · Rounding changes an official grade boundary and can shrink a provisional interval.** The weighted result snaps to an integer within `1e-12`. Six pillars of **89.9999999999995** therefore reconcile to **90/A** in the calculation. A SQLite snapshot with those pillars and the correct **89/B** comes back ungraded. The existing `89.999999996` regression is outside the snap window and passes. The interval independently rounds its exact upper endpoint: at **85.6%** coverage with earned mass **73**, the service returns **[73, 87]** and the formula gives **[73, 87.4]**. Persisted lower and score fields are treated as earned mass by range checks alone. The score and interval need one defined precision and a documented provenance for earned mass. [fleetCalculations.ts:60](src/server/features/fleet/services/fleetCalculations.ts#L60) · [fleetEvidence.ts:42](src/server/features/fleet/services/fleetEvidence.ts#L42) · [Precision regression](scripts/fleet-overview.integration.test.ts#L799)

**F05 · Loader prefetch leaves a client-only first paint and pins the original workspace.** The route loader obtains authorized data. The root wraps the entire app outlet and query provider in `ClientOnly`, whose installed server implementation returns its empty fallback. Using the installed package, React SSR rendered the table marker by itself and emitted an empty string with the same wrapper. After mount, `FleetOverviewView` also waits on its own organization query even with loader data. `initialOrgId ?? orgContextQuery.data?.organizationId` keeps choosing the loader workspace while the mounted view has that prop, even after the organization query resolves another workspace. The RPC still enforces request entitlement and organization consistency. The client bug can show an old workspace's cached rows until the route or query state changes. [onsite.tsx:6](src/routes/_app/onsite.tsx#L6) · [Root render](src/routes/__root.tsx#L142) · [App outlet gate](src/routes/_app/route.tsx#L26) · [FleetOverviewView.tsx:33](src/client/features/fleet/FleetOverviewView.tsx#L33) · [FleetOverviewView.tsx:112](src/client/features/fleet/FleetOverviewView.tsx#L112)

### P2

**F06 · Clearing a project domain preserves its obsolete Fleet association.** The project edit path can clear the nullable domain. Host validation runs only when `liveProjectDomain` is truthy. The SQLite witness keeps **85/B** and the old audit link after clearing the domain. A nonempty replacement host is already rejected by the existing regression. Make the binding require a current, nonempty canonical host or approved alias. [FleetRepository.ts:113](src/server/features/fleet/repositories/FleetRepository.ts#L113) · [ProjectRepository.ts:96](src/server/features/projects/repositories/ProjectRepository.ts#L96) · [Existing remap fixture](scripts/fleet-overview.integration.test.ts#L736)

**F07 · The schema permits mismatched lineage and the hot read grows with all retained history.** Single-column foreign keys establish that each parent exists. They allow a run to name another org's roster, an attempt to name a member outside its run's roster, and a snapshot to disagree with its attempt. The reviewed read joins filter the tested foreign run and reject inconsistent snapshot member/project IDs. This is a storage integrity gap for future publishers. The four-query count is stable, while each history query loads all matching rows and globally orders them. The SQLite plan used the org prefix of the run index, indexed joins, and a temporary B-tree for snapshot ordering. The service sorts the rows again. Two years of weekly baselines for 87 members imply **9,048 attempts plus 9,048 snapshots** before diagnostic runs or retries. Current-roster-only selection also resets history on a version change, including unchanged domains. Give stable member identity and old-version continuity an explicit contract before introducing new collection. [SQLite Fleet schema](src/db/fleet.schema.ts#L103) · [Postgres Fleet schema](src/db/pg/fleet.schema.ts#L106) · [FleetRepository.ts:145](src/server/features/fleet/repositories/FleetRepository.ts#L145) · [FleetService.ts:329](src/server/features/fleet/services/FleetService.ts#L329) · [DESIGN.md:101](DESIGN.md#44-performance-budget)

**F08 · A valid roster digest approves one manifest with multiple possible project outcomes.** The digest now includes category emoji and the importer rejects a malformed timestamp or mismatched hash before opening D1. The write resolves project IDs after digest verification, silently choosing the first active project by created time and ID for duplicate host matches. An initially unmapped row can stay fixed on same-version replay even if the project later exists. The digest also omits persisted aliases, which are currently always an empty array. The approval file and execution permissions provide the operator trust boundary. `approvedBy` is an informational string with no verification in the CLI. The importer is deliberately local D1, using Wrangler `remoteBindings: false`. Describe that behavior in the runbook and bind approval to the exact planned mapping if approval is meant to authorize those relationships. [Importer hash](scripts/import-fleet-roster.ts#L43) · [Import and replay](scripts/import-fleet-roster.ts#L88) · [Project selection](scripts/import-fleet-roster.ts#L125) · [Importer tests](scripts/import-fleet-roster.test.ts)

**F09 · Evidence disclosure can show the wrong Jakarta calendar date and domain names lack row-header semantics.** The service accepts D1's UTC space-delimited timestamps, then returns the raw values for latest attempt and observation. The UI feeds them to `new Date` and into HTML `dateTime`. With `TZ=Asia/Jakarta`, Node parses persisted `2026-11-22 18:30:00` as local time and displays **22 Nov**. The intended UTC instant displays **23 Nov** in Jakarta. The table has semantic column headers, but each domain is a data cell, so users navigating by row and column may lose the property name. The zero-score styling promised by the design is also absent. The named tab stop, caption, sort states, reduced-motion spinner, textual status, and live result count are present. Source-token estimates for the light large critical count and the dark pressed filter are **3.56:1** and **6.41:1** respectively, above the applicable **3:1** and **4.5:1** thresholds for those pairs. Full-page conformance remains unverified by token checks. [FleetService.ts:245](src/server/features/fleet/services/FleetService.ts#L245) · [Evidence disclosure](src/client/features/fleet/FleetEvidenceDisclosure.tsx#L50) · [Matrix row](src/client/features/fleet/FleetMatrixRow.tsx#L125) · [DESIGN.md:52](DESIGN.md#23-alternate-and-edge-case-paths) · [W3C WCAG 2.1 minimum contrast](https://www.w3.org/TR/WCAG21/#contrast-minimum)

## Implementation pointers and acceptance checks

### 1. Keep attempt, observation, and binding state distinct · F01 and F06

Edit `src/server/features/fleet/services/FleetService.ts`, `src/server/features/fleet/services/fleetCalculations.ts`, and `src/server/features/fleet/repositories/FleetRepository.ts`. Index admitted weekly observations by run item. For the latest completed weekly envelope, require its own admitted observation before allowing the current grade to survive. Once that condition holds, retain observation-time precedence so an older valid snapshot finishing late cannot rewind the dashboard. Route a completed envelope without a usable observation to `unavailable` with an explicit missing-evidence reason. Preserve the last good score and date.

```ts
const latestObservation = admittedWeeklyObservations.find(
  ({ snap }) => snap.runItemId === latestWeeklyAttempt?.id,
);
const completedWithoutObservation =
  latestWeeklyAttempt?.status === "completed" && !latestObservation;

// Apply this at the existing unavailable precedence, after unmapped/exempt.
if (completedWithoutObservation) return "unavailable";
```

At the member projection, resolve the normalized active project host first. Require it for the existing canonical/alias comparison. A cleared domain yields `projectId: null`. Reuse the same normalization in the importer. Add both regressions to `scripts/fleet-overview.integration.test.ts` and keep the existing delayed valid completion case.

```ts
await attempt("prior", "completed", baseline, { score: 85 });
await attempt("snapshotless", "completed", later);
expect(await row()).toMatchObject({
  status: "unavailable",
  score: null,
  lastGoodScore: 85,
  lastGoodObservedAt: baseline,
});
```

### 2. Require complete incident and comparison evidence · F02 and F03

Edit `src/server/features/fleet/services/fleetEvidence.ts` and `src/server/features/fleet/services/fleetCalculations.ts`. Remove time inheritance. Validate both probe identities, distinct trusted contexts, matching scope and outcome, and the expected production intent. Use an allowlist expressing the three eligible PRD outcomes. Keep provider challenges as diagnostic evidence. Require an explicit reproducible test on both the current clock and historical observation clock.

```ts
if (!primary || !corroboration) return false;
if (!Number.isFinite(primary.confirmedAtMs)) return false;
if (!Number.isFinite(corroboration.confirmedAtMs)) return false;
const oldest = Math.min(primary.confirmedAtMs, corroboration.confirmedAtMs);
const newest = Math.max(primary.confirmedAtMs, corroboration.confirmedAtMs);
// Use these values in the existing chronology, independence and freshness checks.
```

Make the parameter set of `computeVerifiedComparisonKey` required and validate its values at the persistence boundary. Add the canonical identity fields to both Fleet schemas and migrations, or attach the identity to a validated immutable evidence record. Verify each candidate digest from its own identity payload before trend arithmetic. Until that payload is available, return `trendDelta: null` for an unverifiable key. Keep a fixture with two fully verified matching identities, plus distinct fixtures for a missing dimension and a changed panel.

```ts
const verifiedKey = (point: PersistedPoint) =>
  point.identity &&
  computeVerifiedComparisonKey(point.identity) === point.comparabilityKey
    ? point.comparabilityKey
    : null;

const currentKey = verifiedKey(current);
if (!currentKey || currentKey !== verifiedKey(prior)) return null;
```

### 3. Floor a fixed-point result once and retain the interval · F04

Edit `src/server/features/fleet/services/fleetCalculations.ts` and `src/server/features/fleet/services/fleetEvidence.ts`. Specify the decimal scale at ingestion. A scale of 13 supports both reviewed near-boundary fixtures, or derive exact units from the canonical decimal values already accepted by the contract. Use integer division for the grade boundary. If choosing a narrower scale, explicitly migrate or quarantine old over-precision points and add a compatibility fixture. Round only for display, outward for interval endpoints if using whole numbers. Replace the generic score fallback with a field representing verified observed weighted contribution. Carry the field and its validation into both dialects.

```ts
// units and scale come from validated canonical decimals.
const numerator = pillars.reduce(
  (sum, { units, weight }) => sum + units * BigInt(weight),
  0n,
);
const headline = Number(numerator / (100n * scale));
const grade = gradeFor(headline);

// Compute the interval in corresponding fixed units before formatting it.
const upperUnits = lowerUnits + 100n * scale - coverageUnits;
```

Add three boundary assertions in `scripts/fleet-overview.integration.test.ts`: exact golden **38/F**, the representably below-90 fixture **89/B**, and the partial **[73, 87.4]** or an explicitly outward-rounded display.

### 4. Prove the initial HTML and tenant handoff · F05

Edit `src/routes/__root.tsx`, `src/routes/_app/route.tsx`, `src/routes/_app/onsite.tsx`, and `src/client/features/fleet/FleetOverviewView.tsx`. Give the outlet an SSR-safe provider scoped to the request, and keep browser-only analytics and devtools behind `ClientOnly`. Check the authenticated parent gate in both Access and hosted modes. Have the route loader seed the organization and Fleet query states together, carrying authorized empty and error statuses as typed states. Use the resolved workspace as authoritative after the organization query completes.

```tsx
const activeOrganizationId =
  orgContextQuery.data === undefined
    ? initialOrgId
    : orgContextQuery.data.organizationId;

const initialFleet =
  initialOrgId === activeOrganizationId ? initialData : undefined;
```

Test an allowed cold request for table HTML before hydration. Test an unauthorized cold request for no Fleet rows in the body **or serialized loader state**. Then change the workspace in a mounted view and assert old rows disappear immediately. Keep the expected-org consistency check on every Fleet RPC. Use a per-request query cache for SSR so one request cannot seed another.

### 5. Bound and enforce persistence invariants · F07

Edit `src/db/fleet.schema.ts`, `src/db/pg/fleet.schema.ts`, the dialect migrations, and `src/server/features/fleet/repositories/FleetRepository.ts`. A first index aligned with the overview join is small and portable.

```ts
index("fleet_runs_org_roster_idx").on(
  table.organizationId,
  table.rosterVersionId,
);
```

Use a tenant/version-bound roster FK on runs and align the run item's run/member roster references. Add a snapshot-to-attempt lineage constraint or enforce exact equality in the atomic publisher before admitting the point. Preserve the current project-deletion behavior in any composite key design. Add real migration scenarios for mismatched lineage and null project references on both engines. Extend schema parity to verify the leading column order of secondary indexes used by Fleet and the semantics of any added checks.

Trim unused evidence keys from the overview projection. Select the current admitted attempt, the latest usable observation, and the prior official observation needed for comparison. Preserve a separately addressable last-good point beyond the comparison window. A fixed cap on recent rows would break the existing regression with twenty partials before the last good point. Normalize timestamps before pushing ordering or time bounds into SQL. Assert result invariants and maximum rows read in a local two-year fixture, independent of deployment latency.

### 6. Bind exact roster mappings to approval · F08

Edit `scripts/import-fleet-roster.ts` and `scripts/import-fleet-roster.test.ts`. Resolve candidates into a deterministic plan with an explicit `projectId: null` for unmapped rows. Treat duplicate host matches as a choice for the approver. Include the sorted rows, mappings, aliases, organization and version in the approved digest. Recheck the selected IDs, domains, and active tenant inside the same transaction or guarded D1 batch used to apply the plan. Use a new version for an approved mapping change.

```ts
const rows = resolvedMembers
  .map(({ canonicalHost, projectId, aliases, ...attributes }) => ({
    canonicalHost,
    projectId,
    aliases: [...aliases].sort(),
    ...attributes,
  }))
  .sort((a, b) => a.canonicalHost.localeCompare(b.canonicalHost));
const plan = { organizationId, versionTag, members: rows };
const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
```

Run positive apply and same-plan replay against disposable D1 state. Assert a changed mapping or ambiguous candidate stops the apply with no version or member writes. Assert that a constraint failure leaves the batch empty. Keep the local D1 boundary documented if provider-portable import is a future feature.

### 7. Normalize timestamps and add row semantics · F09

Edit `src/server/features/fleet/services/FleetService.ts` and `src/client/features/fleet/FleetMatrixRow.tsx`. Serialize both admitted timestamps from validated UTC milliseconds. Let the existing formatter choose Jakarta presentation. Use a native `<th scope="row">` for the domain with the current cell styling. In `src/client/features/fleet/FleetEvidenceDisclosure.tsx`, keep `<time dateTime={iso}>` and verify its visible text in a fixture for a UTC date that rolls over in Jakarta.

```ts
const toIso = (value: string | null | undefined) => {
  const millis = parseUtcTimestampMs(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const lastObservedAt = toIso(currentSnapshot?.observedAt);
const latestAttemptAt = toIso(latestWeeklyAttempt?.completedAt);
```

Align `DESIGN.md` and `CODEBASE.md` with the tested four-query source, the exact first-paint contract, and the preview boundary. Update the zero-value styling or its design entry with a single agreed treatment. Document exact checks for the measured claims. For the next Stage 1 review, prioritize F01–F05 and their acceptance tests before using the preview grade, critical count, or trend as a triage signal.
