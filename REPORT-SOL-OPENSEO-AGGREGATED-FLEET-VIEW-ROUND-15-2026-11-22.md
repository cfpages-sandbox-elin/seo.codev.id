# OpenSEO Aggregated Fleet View · Stage 1 review · Round 15

**7.10 / 10.00 overall. Four P1 findings and zero P0 findings.** The private read-only preview has a working foundation. Four reviewed paths can tell the operator the wrong thing about a property, an evidence interval, a critical incident, or a trend. Resolve those findings before relying on the dashboard for fleet triage.

Reviewed on 22 November 2026 against the local working tree based on `0512c7423284a58283723a61cdea57b5b36b485e`, including the modified and untracked fleet implementation. The requested `FleetFilterBar.tsx` is implemented as [FleetFilterToolbar.tsx](src/client/features/fleet/FleetFilterToolbar.tsx). The review uses the read-only preview defined in [DESIGN.md](DESIGN.md#verification) and the applicable overview, identity, and scoring requirements in [the PRD](<C:/Users/THINKPAD/OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md>). Full-product scheduling, write actions, exports, and historical drill-down remain roadmap scope. The preview score applies to the reviewed source, tests, and design. Stage 2 carries zero weight. Live Access Google SSO, deployed D1 bindings and migrations, deployed browser screenshots, and edge p95 latency are reserved for Stage 2.

I selected the weights because the request did not specify them. The scores are based on current source and fresh checks. I skipped earlier standalone reports. The requested CODEBASE.md contains historical ratings, one of which was visible while locating its current implementation section. It was excluded from the calculation.

## Valuation

| Vector | Weight | Score / 10 | Contribution | Basis |
|---|---:|---:|---:|---|
| Architecture and contracts | 20% | 7.0 | 1.40 | Clear route → RPC → service → repository split, organization-scoped query, seven dispositions, and distinct last-good fields. The source can attach data to the wrong domain, the initial route paints loading states, and attempt freshness is missing from the rendered row. F01, F05. |
| Persistence and dual-dialect parity | 20% | 7.4 | 1.48 | Both migration chains executed locally. Matching schema shapes and indexed joins. Foreign keys permit inconsistent lineage, and the overview loads all history for the selected roster. F06, F07. |
| Edge cases and numerical robustness | 25% | 5.8 | 1.45 | Median and integer deltas work on admitted points. SQL-backed fixtures cover important admission cases. Provisional ranges, critical confirmation, and comparison provenance fail essential invariants. Eight-decimal rounding can promote a below-threshold input. F02–F04, F08. |
| Security and authorization | 15% | 7.6 | 1.14 | Request-derived tenancy, fail-closed flag and org gate, explicit permission, and app-side Access JWT validation. The import digest omits project bindings and persisted fields, and write-time tenant lineage is weaker than the read gate. F06, F09. |
| Accessibility and design | 10% | 8.3 | 0.83 | Native table, caption, sortable buttons, `aria-pressed`, named links, live result counts, and light/dark text tokens. The claimed contrast target is overstated and the wide table lacks an explicit named keyboard scroll region. F10. |
| Code quality, strict typing, and tests | 10% | 8.0 | 0.80 | Strict TypeScript, clean focused lint, and 362 focused passes. Tests miss several cross-boundary invariants, the built-in SQLite path is stronger than the permanent PostgreSQL and importer coverage, and documentation overstates some guarantees. F09–F11. |
| **Overall** | **100%** | **7.10** | **7.10** | Calculated as the sum of each score × weight. |

P1 is a material failure of a preview promise under a credible input or operator flow. P2 is a bounded contract, integrity, or operational risk. P3 is maintainability or verification accuracy. Deductions are assigned to the vector where the failure is most relevant. Repository-wide failures outside the fleet change set are reported as release-verification evidence and did not independently lower the fleet score.

## Verification

| Stage 1 check | Result |
|---|---|
| `pnpm types:check` | Passed. The root [tsconfig.json](tsconfig.json) enables `strict`. |
| Type-aware Oxlint on fleet source, tests, and changed wiring | **0 warnings, 0 errors.** The two focused passes reported 23 and 5 files respectively. |
| `pnpm lint` | **0 warnings, 2 errors.** Unused `vi` in [serpCache.test.ts:1](src/custom/serpCache.test.ts#L1) and an unsafe cache-result assertion in [serpCache.ts:64](src/custom/serpCache.ts#L64). Both files matched HEAD. |
| Focused Vitest | **362/362 passed across five files.** See the command below. This count includes the full existing schema-parity file. |
| `pnpm test:ci` | **227/234 files passed; 1,717 passed, 9 failed, 2 skipped.** Failures occurred in the preview Access shell tests, string retention, SAM skill frontmatter parsing, Google OAuth/account cleanup and migration, and workspace-merge setup. The run reported Windows `EPERM`, hook or child-process timeouts, and preview command/skill parsing assertions. Baseline causality was not established for every failure. |
| Design contract validator | Passed. One page contract and all 13 required principles present. This validates document structure. |
| Local SQLite | Python SQLite 3.50.4 applied all **57** migrations with foreign keys enabled and an empty `foreign_key_check`. The focused libSQL integration exercised the fleet migration through the production repository and service. |
| Local PostgreSQL | PGlite PostgreSQL 18.7 applied all **35** migrations. A scratch Vitest fixture used Drizzle's PostgreSQL SQL generation and the production repository/service to retrieve 85/B for the entitled organization and an empty result for a different organization. It also confirmed that PostgreSQL accepts a run linked to a different organization's roster. This fixture uses an embedded PostgreSQL engine and a proxy adapter. |
| Generated schema metadata | Both current journal entries match the migration filenames. The two generated snapshots and their migrations agree on 10 fleet tables and 16 declared index names. The two snapshots agree on per-table column names and the fleet index name set. |
| Independent SQLite probes | Five isolated fixtures reproduced the two host-attribution cases and F02–F04 through the real fleet migration, repository, and service. They asserted the current bad outputs to establish reproducibility. The remediation section gives the desired regression assertions. |
| Manifest | 87 source entries, 87 distinct normalized hosts, and zero malformed or duplicated hosts in the static fixture. |
| Open Code Review | Used workspace preview and local rule resolution for inventory, with the review performed here. Of 34 reviewable entries, 32 received substantive inspection (94.1%). The other two were generated snapshots covered by the metadata and execution checks. Of the 11 OCR exclusions, seven tests/docs came back into the manual review and four prior-round reports were excluded. The PRD and supporting auth, routing, and UI primitives were also inspected. |

```powershell
pnpm exec vitest run src/db/schema-parity.test.ts src/serverFunctions/fleet.test.ts src/server/features/fleet/services/FleetService.test.ts scripts/import-fleet-roster.test.ts scripts/fleet-overview.integration.test.ts
```

### Verified behavior worth preserving

- The RPC rejects missing or disabled flags, the wrong organization, unknown roles, and mismatched requested workspace identity. The repository scopes roster and run reads to the authorized organization, requires a live project from that organization for link visibility, and discards a snapshot when its member/project IDs disagree with the attempt. The integration fixture exercises exclusion of a foreign run. [RPC gate](src/serverFunctions/fleet.ts#L16) · [Repository](src/server/features/fleet/repositories/FleetRepository.ts#L86) · [Foreign-run test](scripts/fleet-overview.integration.test.ts#L231)
- The app validates the Access assertion cryptographically with the configured issuer and audience. Access mode intentionally treats policy-admitted identities as owners of the shared workspace. The source contract therefore relies on the perimeter for owner-only Google admission. The deployment template provisions an email allow policy. Actual Google IdP and audience bindings are Stage 2. [JWT verifier](src/middleware/ensure-user/cloudflareAccess.ts#L60) · [Delegated context](src/middleware/ensure-user/delegated.ts#L80) · [Access policy template](deploy/alchemy/alchemy.access.ts#L60)
- Admitted observations require a terminal, same-project attempt with a valid clock. A failed parent, future observation, or observation after parent completion is filtered out. A snapshot-less partial leaves its own coverage blank and can preserve the prior last-good result. Failed and partial observations stay outside the official median and trend baseline. The median handles even, odd, and empty sets. [Observation admission](src/server/features/fleet/services/fleetObservations.ts#L26) · [Service](src/server/features/fleet/services/FleetService.ts#L132) · [Median](src/server/features/fleet/services/fleetCalculations.ts#L439)
- The active table sort puts `aria-sort` on the appropriate `th`, sorts null values last, and provides a native button for each sortable column. Badge state and trend direction are expressed in text. The shared Table component provides horizontal overflow, and the header can paint the selected theme before hydration. [Sortable table](src/client/features/fleet/FleetMatrixTable.tsx#L37) · [Sort behavior](src/client/features/fleet/fleetSort.ts#L48) · [Theme script](src/routes/__root.tsx#L137) · [W3C sortable table pattern](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/)

## Findings

### P1 — Fix before relying on preview scores

**F01 — Project ID equality allows evidence from a different canonical host.** Both the project mapping and snapshot admission check IDs. The repository never compares the live project's editable domain to the approved roster host, and the observation filter never compares the snapshot's stored host to the member. The real SQLite fixture displayed `fleet-stage1.example` as 95/A after its snapshot host was switched to `different.example`. A second fixture changed the linked project's domain and the dashboard continued displaying its old approved association and 85/B. Standard project settings allow the domain to change. This can misattribute a grade and audit link during a normal project edit. [FleetRepository.ts:86](src/server/features/fleet/repositories/FleetRepository.ts#L86) · [fleetObservations.ts:52](src/server/features/fleet/services/fleetObservations.ts#L52) · [ProjectRepository.ts:96](src/server/features/projects/repositories/ProjectRepository.ts#L96)

**F02 — Provisional intervals can publish invented precision.** At 85% coverage, six 100-point pillar values and absent endpoints produce **[100, 100]**. The unknown mass is 15, so an uncapped interval of width zero cannot be correct. With the same fixture and persisted endpoints `[0, 15]`, the helper returns those endpoints with no check against earned mass. It also accepts `[60, 74]` at the same coverage. Summing unweighted pillar observations as if they covered the full rubric cannot recover how much evidence contributed. Unverified intervals are materially misleading even though the row stays ungraded. [fleetEvidence.ts:50](src/server/features/fleet/services/fleetEvidence.ts#L50) · [PRD §3](<C:/Users/THINKPAD/OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md>)

**F03 — Undated or incomplete incident corroboration can publish a cap and critical flag.** The colon-delimited legacy path accepts two unequal IDs with no timestamps, source contexts, or intent verification. The real SQLite fixture reduced six 90-point pillars to **59/F** and counted **one critical flag** based entirely on that token. The structured fallback also accepts a blank primary ID and unequal corroboration ID when a Boolean claims independence. A standalone probe also accepted a confirmation dated after the reference clock when observation time was absent. The service uses the parser for both historical cap and current flag. [fleetEvidence.ts:108](src/server/features/fleet/services/fleetEvidence.ts#L108) · [fleetEvidence.ts:150](src/server/features/fleet/services/fleetEvidence.ts#L150) · [fleetCalculations.ts:211](src/server/features/fleet/services/fleetCalculations.ts#L211) · [FleetService.ts:217](src/server/features/fleet/services/FleetService.ts#L217)

**F04 — Comparison keys establish shape and equality only.** Two official snapshots with `weekly-comparison-v1:placeholder` produce **+4**. A 64-character hex string also passes shape validation with no binding to the snapshot's panel, applicability weights, collector, metric/profile, or source scope. The key generator fills absent dimensions with shared defaults and its repository callers are tests. A changed scoring method can therefore enter a displayed and sortable trend when upstream uses the same placeholder or under-specified key. Comparing the immediately preceding official point is correct. Require evidence-derived identity for each point before computing a delta. [fleetEvidence.ts:227](src/server/features/fleet/services/fleetEvidence.ts#L227) · [fleetCalculations.ts:417](src/server/features/fleet/services/fleetCalculations.ts#L417)

### P2 — Fix the source contracts and coverage gaps

**F05 — Cold routes render the shell and loading states, and attempt dates do not reach the row.** The route declares just a component. The view waits for organization context and then fetches fleet data. Both query-dependent loading branches are reachable, and the hosted parent can additionally hold its outlet behind a client session check. The early theme script can prevent a theme flash. Data or entitlement cannot be ready in the first authorized HTML through this path. Separately, the DTO already returns `lastObservedAt` and `latestAttemptAt`, but the row renders only the last-good date. A fresh failed retry and an older successful score are therefore hard to distinguish. [onsite.tsx:4](src/routes/_app/onsite.tsx#L4) · [parent route](src/routes/_app/route.tsx#L17) · [FleetOverviewView.tsx:26](src/client/features/fleet/FleetOverviewView.tsx#L26) · [FleetMatrixRow.tsx:15](src/client/features/fleet/FleetMatrixRow.tsx#L15) · [TanStack external data loading](https://tanstack.com/router/latest/docs/guide/external-data-loading)

**F06 — Storage accepts cross-lineage facts.** Run organization and roster version reference separate parents. Run item member and project can disagree with their run's roster or tenant. Snapshots can disagree with the parent attempt. The reproduced PostgreSQL cross-roster insert succeeded, exposing a write-side integrity gap. The overview's joins and post-filtering excluded that fixture from the tenant response. The same single-column constraints appear in SQLite. [SQLite schema](src/db/fleet.schema.ts#L109) · [PostgreSQL schema](src/db/pg/fleet.schema.ts#L103) · [Read filtering](src/server/features/fleet/repositories/FleetRepository.ts#L174)

**F07 — Four queries is a round-trip bound. History volume still grows with retention.** The overview materializes all attempts and snapshots attached to the chosen version, including unused lease/error detail and evidence references. Local SQLite uses the org-started index on organization alone, then indexes for run-item/snapshot joins, then temporary B-trees for both global sorts. The service sorts the same records again. For 87 properties over two years of weekly data, the read can materialize about **9,048 attempts plus 9,048 snapshots** before diagnostics and retries. The exact roster ID criterion also hides prior official points for unchanged domains when a new roster is approved. Preserve scoped history and last-good semantics when bounding the read. [FleetRepository.ts:76](src/server/features/fleet/repositories/FleetRepository.ts#L76) · [FleetService.ts:319](src/server/features/fleet/services/FleetService.ts#L319) · [SQLite run index](src/db/fleet.schema.ts#L137)

**F08 — The official arithmetic uses floating-point rounding upstream of grade flooring.** The comments say integer hundredths, but the implementation sums floating-point products and rounds to eight places. Six admitted inputs of `89.999999996` produce exactScore **90**, headline **90**, grade **A**. The existing `89.999999` fixture correctly returns 89/B and misses that interval. There is no persisted scale restriction for either dialect. Either reject excessive precision under a documented scale or represent the full approved input precision directly, then floor the weighted integer result. [fleetCalculations.ts:55](src/server/features/fleet/services/fleetCalculations.ts#L55) · [Pillar validator](src/server/features/fleet/services/fleetCalculations.ts#L128) · [Existing grade-boundary fixture](scripts/fleet-overview.integration.test.ts#L539)

**F09 — The importer verifies manifest fields while choosing project bindings at apply time.** The digest omits `projectId`, `categoryEmoji`, and `aliasesJson` even though the rows store them. Two active same-host projects are legal and the importer silently picks the first by creation date and ID. Approval therefore cannot distinguish a mapped, unmapped, or ambiguously mapped row. An invalid nonempty `approvedAt` can be stored under the unique version tag and permanently skipped by the reader. The idempotency branch then returns that row as success. The existing tests cover CLI parsing and rejection before DB access. They do not exercise successful application, replay, or atomicity. [Hash](scripts/import-fleet-roster.ts#L35) · [Replay and resolution](scripts/import-fleet-roster.ts#L95) · [Write batch](scripts/import-fleet-roster.ts#L139) · [Importer tests](scripts/import-fleet-roster.test.ts)

**F10 — The written contrast claim exceeds the CSS.** On the checked tokens, the critical large count has approximately **3.56:1** on the light card and **4.75:1** on the dark card. Its large bold size satisfies the AA **3:1** threshold. The active filter text is approximately **6.08:1** in light and **6.41:1** in dark. Both meet normal-text AA and fall short of the blanket **7:1** design claim. Body/card text was approximately **18.10:1** and **13.33:1**. The calculations cover these source-token pairs. The table scroller has no authored tab stop or accessible region name. With a 13-column matrix reserved for horizontal scrolling, give keyboard users an explicit focusable scroll target and preserve a visible focus indicator. The spinner also lacks a reduced-motion override. [Theme tokens](src/client/styles/app.css#L66) · [Metric card](src/client/features/fleet/FleetMetricCards.tsx#L45) · [Filter toolbar](src/client/features/fleet/FleetFilterToolbar.tsx#L38) · [Shared table scroller](src/client/components/ui/table.tsx#L22) · [Design contrast](DESIGN.md#43-accessibility-target) · [W3C minimum contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

### P3 — Keep evidence and source claims aligned

**F11 — Documentation overstates enforcement and the code duplicates or loosens some contracts.** The design verification section calls the database reads member-ID chunked and cites a render timing with no reproducible Stage 1 recipe there. The implementation is fixed round-trip per roster. The design claims sticky borders, while the fleet table inherits the standard scrolling wrapper and renders no sticky cell/header. DTO grade, tier, intent, and platform use wide strings despite shared enums. Rubric weights live in two modules, and repository/service/observation layers each sort evidence. The current architectural layering is sound and can get simpler through the F02, F07, and F08 fixes. [DESIGN.md:177](DESIGN.md#L177) · [DESIGN.md:211](DESIGN.md#L211) · [FleetService.ts:28](src/server/features/fleet/services/FleetService.ts#L28) · [fleetEvidence.ts:16](src/server/features/fleet/services/fleetEvidence.ts#L16) · [fleetCalculations.ts:37](src/server/features/fleet/services/fleetCalculations.ts#L37)

## Implementation pointers and regression oracles

The following patches are implementation proposals. The first four test snippets fit inside [scripts/fleet-overview.integration.test.ts](scripts/fleet-overview.integration.test.ts) and reuse the existing `attempt`, `row`, `db`, and clock fixtures. PostgreSQL should exercise the same invariant when it is enforced in storage.

### F01 — Preserve approved host identity

In [FleetRepository.ts](src/server/features/fleet/repositories/FleetRepository.ts#L86), include `projects.domain` in the approved-member join. Normalize a project domain with the existing domain-mode normalization used by project settings, while keeping origin comparison distinct from search-domain normalization. A project may match the roster's canonical host or an explicitly approved alias. On mismatch, set the effective `projectId` to null. Never rebind to an arbitrary replacement project at read time.

In [fleetObservations.ts](src/server/features/fleet/services/fleetObservations.ts#L52), pass the member's approved canonical host with its project ID and reject observations that belong to another host. A case-insensitive DNS match can be made after validating and normalizing both stored hosts. For the current preview, canonical host equality is sufficient and does not imply that a different scheme/port is comparable for trend.

```ts
if (snap.projectId !== member.projectId) return [];
if (snap.canonicalHost.toLowerCase() !== member.canonicalHost.toLowerCase()) {
  return [];
}
```

```ts
it("keeps a different host's observation out of the approved row", async () => {
  await db.update(projects).set({ domain: host });
  await attempt("other-host", "completed", baseline, { score: 95 });
  await db.update(fleetSnapshots).set({ canonicalHost: "different.example" });

  expect(await row()).toMatchObject({
    canonicalHost: host, projectId: "pa", score: null, lastGoodScore: null,
  });
});

it("invalidates a mapping when the linked project moves", async () => {
  await db.update(projects).set({ domain: host });
  await attempt("same-host", "completed", baseline, { score: 85 });
  await db.update(projects).set({ domain: "different.example" });

  expect(await row()).toMatchObject({
    canonicalHost: host, projectId: null, status: "unmapped", score: null,
  });
});
```

### F02 — Derive intervals from earned rule contributions

In [fleetEvidence.ts](src/server/features/fleet/services/fleetEvidence.ts#L50), replace both fallbacks with reconstruction from validated normalized rule contributions, or consume a persisted `earnedScoreMass` that was calculated and validated by the publication path. Keep the preview's coverage and observed facts for legacy rows without that evidence. Reject inconsistent inputs before applying the cap. Store precise endpoints if retaining them, with rounding confined to display. Use the same observation-time cap for an historical interval that `officialPoint` uses for an historical grade.

```ts
const C = coverageUnits;
const L = earnedMassUnits;
if (C < 80 * unit || C >= 100 * unit || L == null || L < 0 || L > C) {
  return null;
}
const U = L + 100 * unit - C;
const cap = confirmedCap ? 59 * unit : 100 * unit;
return { lower: Math.min(L, cap) / unit, upper: Math.min(U, cap) / unit };
```

```ts
it("keeps partial coverage visible without inventing an interval", async () => {
  await attempt("missing-rule-mass", "partial", baseline, {
    score: 100, coverage: 85,
  });

  expect(await row()).toMatchObject({
    status: "fresh_partial", coverage: 85, score: null, provisionalRange: null,
  });
});
```

Extend the existing 85%-coverage fixture to supply verified earned mass 73 for `[73, 88]`. Supply a same-width persisted interval with the wrong lower endpoint and assert recomputation or rejection. Add one cap case using 59 as the maximum of each verified endpoint.

### F03 — Require dated, independent corroboration

In [fleetEvidence.ts](src/server/features/fleet/services/fleetEvidence.ts#L108), accept a single validated structured schema with eligible failure kind, expected-intent proof, two nonempty probe IDs, two independently identified source contexts, and both probe times. Drop the permissive text and Boolean fallbacks. Parse valid observation/reference clocks. Validate that probes preceded the observation and that the older probe remains within the freshness window. Retain the incident-capped historical grade if the probes were fresh at observation time and hide its current critical flag after those probes age out.

```ts
const oldest = Math.min(primaryAtMs, corroboratingAtMs);
const newest = Math.max(primaryAtMs, corroboratingAtMs);

return Number.isFinite(observedAtMs) &&
  Number.isFinite(referenceTimeMs) &&
  Number.isFinite(oldest) &&
  newest <= observedAtMs &&
  observedAtMs <= referenceTimeMs &&
  oldest >= referenceTimeMs - FRESHNESS_WINDOW_MS &&
  primary.id !== corroboration.id &&
  primary.source !== corroboration.source;
```

```ts
it("does not publish a cap or flag based on an undated legacy token", async () => {
  await attempt("legacy-cap", "completed", later, { score: 59, pillarScore: 90 });
  await db.update(fleetSnapshots).set({
    hasIncidentCap: true,
    incidentReason: "confirmed:site_down:probe-a:probe-b:corroborated",
  });

  expect(await FleetService.getOverview("a")).toMatchObject({
    criticalIncidentsCount: 0,
    domains: [{ score: null, grade: "ungraded", hasIncidentCap: false }],
  });
});
```

### F04 — Verify comparison inputs before comparing

In [fleetEvidence.ts](src/server/features/fleet/services/fleetEvidence.ts#L227) and [fleetCalculations.ts](src/server/features/fleet/services/fleetCalculations.ts#L375), replace permissive key validation with validation of the canonical inputs. Freeze exact project/origin, rubric, panel, applicability/weights, collector, metric, lab profile, and source scope at observation publication. Use a canonical tuple and require its exact digest for each of the two points. Legacy rows without verified inputs can keep their independent grades and emit a null trend.

```ts
const inputs = comparisonInputsSchema.safeParse(snapshot.comparisonInputs);
if (!inputs.success) return null;
const expected = computeVerifiedComparisonKey(inputs.data);
return snapshot.comparabilityKey === expected ? expected : null;
```

```ts
it("does not compare official points that share only a placeholder token", async () => {
  const comparabilityKey = "weekly-comparison-v1:placeholder";
  await attempt("prior", "completed", baseline, { score: 80, comparabilityKey });
  await attempt("next", "completed", later, { score: 84, comparabilityKey });

  expect(await row()).toMatchObject({ score: 84, grade: "B", trendDelta: null });
});
```

Extend the positive comparison fixture to use persisted, verified dimensions. Change just the panel hash and assert that the delta disappears even if the old digest was copied forward.

### F05 — Load authorized initial data at the route and display both dates

In [onsite.tsx](src/routes/_app/onsite.tsx#L4), load the entitlement and first overview in the authenticated route loader and pass the returned state to [FleetOverviewView.tsx](src/client/features/fleet/FleetOverviewView.tsx#L26). Reuse the same server permission gate and expected-org check. Use the router's request-local loader data or a request-scoped SSR QueryClient. The module-level query client in [queryClient.ts](src/client/tanstack-db/queryClient.ts#L14) is unsuitable for storing a private, server-rendered response shared across requests. Account for the [parent route](src/routes/_app/route.tsx#L17) if hosted mode is supported. Render a stable error/denial state when the request resolves that way.

```tsx
loader: async () => {
  const org = await getOrganizationContext();
  return {
    organizationId: org.organizationId,
    overview: await getFleetOverview({
      data: { expectedOrganizationId: org.organizationId },
    }),
  };
},
```

Use the loader result as initial client data under the same organization key. Prove with a local route integration test that an authorized cold request contains the table and an unauthorized one contains no fleet data. In [FleetMatrixRow.tsx](src/client/features/fleet/FleetMatrixRow.tsx#L15), render separate `Latest attempt`, `Observed`, and `Last good` labels with UTC ISO `dateTime` and Jakarta display values. Normalize dates before serialization in [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L237). Cover an attempt failure newer than the last-good timestamp.

### F06 — Add tenant and roster lineage to both schemas

In [src/db/fleet.schema.ts](src/db/fleet.schema.ts) and [src/db/pg/fleet.schema.ts](src/db/pg/fleet.schema.ts), add matching unique parent keys and composite foreign keys. Start with the reproduced run/roster gap, then carry roster identity through run-item membership and enforce snapshot/run-item identity. Preserve existing delete behavior and explicitly handle nullable project assignments. Validate/backfill before adding constraints if any reviewed migration has already been applied, with forward migrations in that case.

```ts
// Parent unique key on fleet_roster_versions:
unique("fleet_roster_versions_org_id_uniq").on(table.organizationId, table.id)

// Child constraint on fleet_runs:
foreignKey({
  columns: [table.organizationId, table.rosterVersionId],
  foreignColumns: [fleetRosterVersions.organizationId, fleetRosterVersions.id],
}).onDelete("cascade")
```

Assert that a run for organization A with B's roster is rejected by both actual migration chains and that a same-org insert succeeds. Keep the read-side scoping checks. Add the same reject/accept matrix for item/member/roster mismatches before enabling a writer.

### F07 — Bound reads without discarding the last good point

In [FleetRepository.ts](src/server/features/fleet/repositories/FleetRepository.ts#L76), stop selecting unused lease, detail, and evidence fields. Add a matching `(organization_id, roster_version_id, started_at)` index to both schema declarations. Normalize timestamps before relying on database sort order. Remove source-level redundant sorts first if TypeScript still owns ordering. When adding bounded SQL selection, separately fetch latest terminal attempt, latest admitted observation, latest official point, and immediate predecessor with per-member selection. A global `LIMIT` or recent-time cutoff loses a valid historical last-good point. For a new roster version, link compatible history by approved stable member identity or the same approved host/project, with an explicit scope-change boundary.

```sql
CREATE INDEX fleet_runs_org_roster_started_idx
  ON fleet_runs (organization_id, roster_version_id, started_at);
```

Use one fixture containing over 20 intervening partials and another with unchanged and remapped members across two roster versions. Verify correct last-good results and inspect row counts and query plans with realistic history on both local dialects.

### F08 — Define and enforce the precision policy

In [fleetCalculations.ts](src/server/features/fleet/services/fleetCalculations.ts#L37), use one shared rubric weight export. Freeze a supported source precision in the rubric contract and validate it at admission. The example below assumes the chosen ingestion contract is exact hundredths after checked parsing. If preserving the current higher-precision fixture is required, scale accordingly or use a decimal representation. Avoid silently rounding an inadmissible input through a grade boundary.

```ts
// Inputs are already validated scaled integers in [0, 10_000].
const weighted = technical * 35 + mobile * 15 + schema * 10 +
  onPage * 15 + readiness * 5 + links * 20;
const exactScore = weighted / 10_000;
const flooredScore = Math.floor(weighted / 10_000);
```

Keep the existing golden result 38/F and add one valid point below A, one exactly at 90, and the reproduced `89.999999996` value. An out-of-scale input should be rejected or produce 89/B under the selected supported representation. It must never be promoted to 90/A.

### F09 — Bind approval to the plan you apply

In [scripts/import-fleet-roster.ts](scripts/import-fleet-roster.ts#L35), resolve and export a sorted, reviewable plan containing every persisted member field and explicit null/mapped project IDs, then approve its SHA-256. Report duplicate active matches as conflicts for the operator to resolve. Apply the exact approved plan after checking that each mapped project is still live, same-org, and host-matching. Validate the effective timestamp before any writes, including when calling `importApprovedRoster` directly. If future effective dates are deliberately supported, report them as pending and keep replay semantics explicit.

```ts
const plan = await resolveRosterPlan(db, organizationId);
if (approval.organizationId !== organizationId ||
    approval.rosterPlanSha256 !== hashCanonicalRosterPlan(plan)) {
  throw new CliUsageError("Approval does not match the target roster plan");
}
const approvedAtMs = parseUtcTimestampMs(approval.approvedAt ?? defaultApprovedAt);
if (!Number.isFinite(approvedAtMs)) {
  throw new CliUsageError("Invalid roster approval time");
}
```

Keep the atomic D1 batch and make same-plan concurrent retries read back the winning same digest. Cloudflare's documented per-statement binding limit favors the existing one-member-per-statement shape inside an atomic batch. Hashing provides integrity against approved bytes. Operator trust comes from the controlled approval source. Add one local successful import/replay fixture that verifies the exact manifest rows, then one ambiguous or changed binding that leaves permanent state untouched. [D1 batch limits](https://developers.cloudflare.com/d1/platform/limits/)

### F10 — Give the wide table a named scroll target

In [src/client/components/ui/table.tsx](src/client/components/ui/table.tsx#L22), allow fleet to pass DOM attributes to the existing overflow wrapper. In [FleetMatrixTable.tsx](src/client/features/fleet/FleetMatrixTable.tsx#L85), apply the name and focus behavior there. Add `motion-reduce:animate-none` to the spinner in [FleetOverviewView.tsx](src/client/features/fleet/FleetOverviewView.tsx#L142). Check the intended AA threshold for text size, plus focus and interactive states, using local rendered fixtures in both themes. Reconcile the 7:1 claim with the actual target or adjust the colors to meet it.

```tsx
<Table
  containerProps={{
    role: "region",
    "aria-label": "Fleet matrix",
    tabIndex: 0,
  }}
  containerClassName="focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
>
```

Verify Tab reaches the region, arrow keys can scroll it at mobile widths, the active sort header alone carries `aria-sort`, and filtering updates the existing polite result count. Keep the native disclosure and link semantics.

### F11 — Tighten the public types and verification records

In [FleetService.ts](src/server/features/fleet/services/FleetService.ts#L28), use the shared union types for grade, tier, intent, and platform. If legacy values need support, put their narrowing in the repository or DTO boundary and retain the expected display. Replace the duplicated observations sort while implementing F07. In [DESIGN.md](DESIGN.md#verification) and [CODEBASE.md](CODEBASE.md#8-hardening--edge-case-audit-ledger), describe the actual fixed-query read, overflow behavior, and checked accessibility results. Keep a permanent PostgreSQL execution fixture and extend the existing schema parity harness to compare ordinary fleet indexes by table and columns.

```ts
type FleetRowTaxonomy = Pick<
  RawFleetMember, "tier" | "siteIntent" | "platform"
> & { grade: FleetGrade };
```

Add the F01–F04 behavior tests first, verify that their assertions fail for the named reason, then land the smallest source fixes and rerun lint, strict type-check, both migration probes, and the five focused suites. Resolve the second-tier source gaps before a new Stage 1 certification.


