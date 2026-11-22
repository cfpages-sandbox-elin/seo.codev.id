# OpenSEO Aggregated Fleet View Stage 1 review

**Review date** 22 November 2026, Asia/Jakarta  
**Reviewer** Engineer Sol, Codex via mcodex  
**Decision** Changes required · **6.8 / 10.0** · **0 P0, 5 P1, 6 P2, 2 P3**

## Executive summary

The read-only preview has a clear RPC → service → repository boundary, an organization-scoped read, nullable pillars in both schemas, and a small UI that reuses the application shell and shared components. Four focused suites passed **314/314** tests. The strongest local persistence evidence is the full **57-migration SQLite journal**, which created all **10** fleet tables with a clean foreign-key check.

The preview can still mislead the operator about what changed and what was measured. Trend comparisons use the rubric version as their only persisted compatibility input. A newer incomplete observation can disappear behind an older grade, and the service accepted a stored Grade A score of **95** backed by six **30**-point pillars. The documented roster importer also exits before reaching the database. These failures affect ordinary preview operations and keep this checkout below the **9.5** Stage 1 bar.

### Snapshot and scoring scope

- Local Git HEAD was `0512c7423284a58283723a61cdea57b5b36b485e`. Git HEAD contains no fleet implementation at the requested paths. The review covers the fleet working-tree files present over that base, including nine tracked modifications and 28 new files. The score applies to those bytes.
- The SHA-256 of the sorted `path sha256` records for the 37 changed source files, joined with LF and no final LF, is `4dfe5529e0b2e5af822501bce5f6f2461b17e9952d3c1b7666fde4004bbcc147`. The PRD SHA-256 is `3301b3a6ab192d6ee332c8b134fd7e2a67f94b9448dcdbc4bb95e8f3827b469c`. This assessment uses current source and test evidence without carrying forward scores or closure claims.
- The source has a read-only preview badge and one fleet RPC. The proposed PRD also describes a full product launch. A publisher, scheduled runs, evidence history, authorized export, attribution, and remediation are pending product slices. The score assesses the implemented preview and its local contracts. The full PRD launch remains unqualified. The roadmap and design record should make the boundary explicit. [PRD](../../../OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md) · [Preview badge](src/client/features/fleet/FleetOverviewView.tsx#L58) · [Current RPC](src/serverFunctions/fleet.ts#L16) · [Roadmap](CODEBASE.md#L209)
- Cloudflare Access wire behavior, production D1 bindings and migrations, live screenshots, and edge latency were excluded with zero deduction. PostgreSQL source, migration and metadata were reviewed locally. PostgreSQL execution was unverified because this checkout has a client driver and no available local PostgreSQL engine. No live database or external review service was used.

| Evaluation vector                            | Score | Basis                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and contracts                   |   6.5 | Clear layer boundaries and read-only RPC. The sole provisioning command cannot start, and the preview contract overstates implemented paths. F01, F05, F12.                                                                                         |
| Persistence and dual-dialect parity          |   6.5 | Both barrels, journals and nullable pillars are present. Shared constraint, query-bound and rollover gaps remain, and metadata parity cannot prove driver behavior. F05–F08.                                                                        |
| Edge cases and numerical robustness          |   5.5 | Valid zero, median, UTC parsing and chronology have positive coverage. Comparability, incomplete evidence selection, completion validation and composite integrity fail. F02–F04.                                                                   |
| Security and authorization                   |   8.0 | Verified-context tenant selection, deny-by-default feature gates, role checks, CSRF and client-safe error translation are wired in source. The RPC test bypasses the transport and Access membership semantics need an explicit contract. F06, F09. |
| Accessibility and design                     |   6.5 | Native controls, sort semantics, labels and live result count are present. Desktop evidence, triage order and light-theme contrast have source-level failures. F10–F11.                                                                             |
| Code quality, strict typing and verification |   7.5 | Both type checks pass, the feature contributes zero reported lint or Knip diagnostics, and the four focused suites pass. Some assertions prove a weaker contract than their description, and scoped formatting fails. F02, F09, F12–F13.            |

All six vectors carry equal weight. The exact mean is **6.75**, rounded half-up to **6.8**. A P0 would invalidate the preview's basic safety or operation system-wide. P1 marks a broken normal operation or materially incorrect operator decision. P2 marks a bounded correctness, accessibility or verification defect. P3 marks documentation or mechanical cleanup. An empty database is handled as roster approval pending, so the failed importer is a provisioning P1. No P0 was established for the read-only preview.

### Evidence and coverage

| Local check                                                                                                                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run src/db/schema-parity.test.ts src/server/features/fleet/services/FleetService.test.ts src/serverFunctions/fleet.test.ts scripts/fleet-overview.integration.test.ts` | **4 files, 314 passed.** Breakdown: 284 schema parity, 15 calculation/service policy, 5 RPC handler, and 10 SQLite service integration cases. Integration uses in-memory libSQL with the new migration. The application's DB binding and batch writer are replaced there.                                                                                                     |
| Full `pnpm test` on Windows, Node v24.18.0                                                                                                                                               | **228 passed files, 5 failed files. 1,672 passed, 8 failed tests** and two additional suite teardown errors. Failures are outside fleet diff paths. Preview shell fixtures failed six cases, three Google suites hit Windows `EPERM` cleanup, and SAM skill parsing rejected the working-tree frontmatter. The files involved were unchanged against HEAD.                    |
| `pnpm types:check` and `pnpm exec tsc --noEmit -p tests/badseo/tsconfig.json`                                                                                                            | Both passed.                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm lint`                                                                                                                                                                              | Exit 1. Two diagnostics in unchanged SERP cache paths, one unused test import and one unsafe narrowing. Zero fleet diagnostics. [Test import](src/custom/serpCache.test.ts#L1) · [Cache narrowing](src/custom/serpCache.ts#L64)                                                                                                                                               |
| `pnpm knip`                                                                                                                                                                              | Exit 1. Two unused exports in unchanged SERP cache code. Zero fleet diagnostics. [Cache exports](src/custom/serpCache.ts#L29)                                                                                                                                                                                                                                                 |
| Scoped `pnpm exec prettier --check`                                                                                                                                                      | Exit 1 on four fleet-wiring files. See F13.                                                                                                                                                                                                                                                                                                                                   |
| Design-contract validator                                                                                                                                                                | Passed. One inventory entry, one page contract, all 13 principle slots present. This validates document structure. [Design contract](DESIGN.md#L146)                                                                                                                                                                                                                          |
| Independent SQLite and Node checks                                                                                                                                                       | All 57 SQLite migrations applied in memory. The first 56 produced zero fleet tables and the last produced ten. `PRAGMA foreign_key_check` returned no violations on the migrated empty database. Local service probes confirmed F03 and F04. The real Node roster command confirmed F01.                                                                                      |
| Local Open Code Review delegation mode                                                                                                                                                   | 37 previewed paths, 31 rule-selected and six default exclusions. All 37 accounted for in the review. The six exclusions were the two Markdown contracts and four Vitest files, reviewed directly. Generated snapshots were reviewed as migration metadata.                                                                                                                    |
| Manifest and UTC spot checks                                                                                                                                                             | **87 rows, 87 distinct lowercase valid-shape hostnames** in the bundled manifest. This is a shape and count check. The parser maps space and ISO-Z forms to the same epoch and rejects unzoned ISO timestamps and impossible dates. [Manifest](src/server/features/fleet/data/fleetManifest.json) · [UTC parser](src/server/features/fleet/services/fleetCalculations.ts#L28) |

Actual PostgreSQL migration and repository execution, a Workerd D1 fixture, and a production bundle build were unexecuted. The grade reflects confirmed source defects and existing proof. The report makes no claim about those runtimes.

## Detailed findings

### P0 blockers

None established in the read-only preview.

### P1 high

| ID  | Finding                                                                                                                                      | Evidence and operator impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | **The roster import command cannot load in Node.**                                                                                           | Running `pnpm exec tsx scripts/import-fleet-roster.ts --help` exited 1 with `ERR_UNSUPPORTED_ESM_URL_SCHEME` for `cloudflare:` before argument handling. The CLI imports the Worker repository, which loads Worker-only D1 and provider modules. Its PostgreSQL dependency also expects an active `withPgClient` scope. An empty installation is left at “Fleet roster approval pending” with no working provisioning command in this slice. [CLI](scripts/import-fleet-roster.ts#L5) · [DB entry point](src/db/index.ts#L1) · [D1 client](src/db/d1/client.ts#L1) · [PG scope](src/db/pg/client.ts#L31) · [Working local seed pattern](scripts/seed-projects.ts#L18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F02 | **The persisted trend contract cannot distinguish series or methods.**                                                                       | The repository assigns `comparabilityKey: item.rubricVersion` and `seriesKey: null`. Neither migration provides the missing series or comparable dimensions. The calc permits a missing series and picks the prior graded observation before determining series. The integration test named “within the same rubric” writes `panel-a`/`panel-b` into `rubric_version` and puts the real-looking keys on a DB object property the repository never reads. As a result, equal-rubric unlike panels can yield a false delta, and a diagnostic point can displace a weekly predecessor. [Repository](src/server/features/fleet/repositories/FleetRepository.ts#L263) · [Comparison](src/server/features/fleet/services/fleetCalculations.ts#L242) · [Fixture writes](scripts/fleet-overview.integration.test.ts#L94) · [Claimed regression](scripts/fleet-overview.integration.test.ts#L255) · [PRD comparison contract](../../../OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md#L48)                                                                                                                                                                 |
| F03 | **Older grades can mask newer incomplete observations, and invalid completion times can control status.**                                    | With a valid 85-point baseline followed by a newer `completed` snapshot at 95% coverage and no AI pillar, the real SQLite-backed service returned `fresh_graded`, score 85, coverage 100%, and an AI pillar of 85. The headline selects the latest _eligible_ official point before choosing current evidence. A subsequent `failed` item dated in the future returned `unavailable` because completion sorting confers authority without rejecting future or invalid timestamps. This can make broken collection look complete or hide valid evidence behind a bad attempt time. Out-of-order completion between two valid snapshots is correctly handled by observation order and should remain so. [Headline selection](src/server/features/fleet/services/FleetService.ts#L136) · [Completion sort](src/server/features/fleet/services/FleetService.ts#L277) · [Disposition](src/server/features/fleet/services/fleetCalculations.ts#L164) · [Existing out-of-order fixture](scripts/fleet-overview.integration.test.ts#L283)                                                                                                                                       |
| F04 | **Official grades are accepted without arithmetic reconciliation, and the persisted schema cannot faithfully represent the score contract.** | The real service accepted stored score 95 Grade A against six pillars of 30 and returned a median of 95 and a +10 delta over the fixture's prior 85. The helper checks field ranges and agreement with the stored letter but does not reconcile weighted inputs. Both dialects declare `score` as a required integer, coverage defaults to 100, and the provisional bounds are integer fields that never reach the view. SQLite `REAL` and PG `real` also differ in precision. Clamping invalid pillars or coverage for display can make corrupt data look measured. This is distinct from F03, which selects the wrong observation even when the stored score is internally consistent. [Official-point checks](src/server/features/fleet/services/fleetCalculations.ts#L66) · [Display sanitization](src/server/features/fleet/services/FleetService.ts#L99) · [SQLite columns](src/db/fleet.schema.ts#L192) · [PG columns](src/db/pg/fleet.schema.ts#L184) · [PRD formula](../../../OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md#L37)                                                                                                        |
| F05 | **Roster import can turn inferred data into a recorded owner approval.**                                                                     | The bundled roster has the expected count today. The import path normalizes project domains ad hoc, silently chooses the first matching active project, sets all enrollments active and all aliases empty, and defaults `approvedBy` to the owner's name. The loader coerces invalid metadata. The digest is a hash of JavaScript array serialization, rather than a verified, canonical approval payload covering exactly what is written. The duplicate and race paths look up the _latest_ tag. An older requested tag can return a generic unique violation despite being the identical approved import. An empty stored digest also passes the first duplicate check. PRD `1 requires explicit, versioned approval and mapping. [Manifest parser](src/server/features/fleet/data/fleetManifest.ts#L23) · [Approval and hash](src/server/features/fleet/repositories/FleetRepository.ts#L72) · [Mapping](src/server/features/fleet/repositories/FleetRepository.ts#L89) · [Race recovery](src/server/features/fleet/repositories/FleetRepository.ts#L149) · [PRD launch contract](../../../OneDrive/MD/OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md#L9) |

### P2 medium

| ID  | Finding                                                                            | Evidence and operator impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F06 | **Database lineage and logical snapshot identity are weaker than the read guard.** | Both schemas allow independently valid foreign keys without requiring the run's roster to own the member, the version to share the run's org, or a snapshot to share its run item's member and project. The preview applies read-side guards, and the current tests establish exclusion from the view. SQL still permits inconsistent rows and multiple logical points per run item. Those can survive until another consumer or import uses them. The parity test compares metadata such as default presence and check names, with unordered constraint tuples, so it does not prove the intended database invariant. [SQLite lineage](src/db/fleet.schema.ts#L105) · [PG lineage](src/db/pg/fleet.schema.ts#L99) · [Read guard](src/server/features/fleet/repositories/FleetRepository.ts#L272) · [Parity checks](src/db/schema-parity.test.ts#L68) · [Current negative control](scripts/fleet-overview.integration.test.ts#L219) |
| F07 | **Overview work grows with all attempt and snapshot history.**                     | The member chunk bounds the count of bind parameters, while both queries fetch every matching historical row. At 87 mapped members the current code makes **7** repository reads. At a single roster version held for 104 weekly runs, one attempt and snapshot each would materialize **18,096** historical rows, even before diagnostics and retries. The service sorts and parses them repeatedly. The attempt query also selects lease and error detail, although the overview returns neither. Independent reads can straddle a publication and briefly pair incompatible versions of attempt and snapshot state. [Repository query loop](src/server/features/fleet/repositories/FleetRepository.ts#L210) · [Service sorting](src/server/features/fleet/services/FleetService.ts#L279) · [Design query budget](DESIGN.md#L101)                                                                                                 |
| F08 | **Rollover of the roster can drop history for unchanged targets.**                 | Imported member primary keys include the roster version. The read path requires the current version's IDs for both members and runs. The same approved project and host can therefore revert to “Never Audited” after a metadata-only roster change. Historical rows remain in storage, yet the overview has no stable member identity or equivalent current-to-history join. [Versioned IDs](src/server/features/fleet/repositories/FleetRepository.ts#L126) · [Current roster lineage filter](src/server/features/fleet/repositories/FleetRepository.ts#L173) · [Run restriction](src/server/features/fleet/repositories/FleetRepository.ts#L239)                                                                                                                                                                                                                                                                                 |
| F09 | **The entitlement tests omit real role and transport boundaries.**                 | The real RPC uses framework middleware, strict input, active organization and a server flag. The test substitutes the builder and removes authentication middleware. Its reader success case uses `owner`, and the “disabled or absent” test only sets `false`. Missing membership or identity, actual member/admin behavior and wire error masking remain untested. Access mode deliberately supplies `owner` for every admitted principal, so an owner-only policy is compatible with the source but app-side reader/operator separation is absent in that mode. The flag and organization gate also leave a visible unauthorized sidebar entry. [RPC](src/serverFunctions/fleet.ts#L16) · [RPC tests](src/serverFunctions/fleet.test.ts#L22) · [Access workspace role](src/middleware/ensure-user/delegated.ts#L83) · [Global middleware](src/start.ts#L4) · [Nav](src/client/navigation/items.ts#L99)                           |
| F10 | **The matrix omits operator evidence and initial triage priority.**                | The initial sort is host-first. Desktop users can never see three pillars or the disclosure, which is hidden at `md`, and the matrix supplies no latest observation age. The disclosure helps on small screens but the labelled audit action remains in the rightmost table column. A known 0% coverage can render as unknown, regardless of the stated zero-data distinction. The host link also bypasses the project's shared safe-external-URL boundary. [Default sort](src/client/features/fleet/FleetOverviewView.tsx#L39) · [Disclosure and coverage](src/client/features/fleet/FleetMatrixRow.tsx#L14) · [Host link](src/client/features/fleet/FleetMatrixRow.tsx#L160) · [Visible columns](src/client/features/fleet/FleetMatrixTable.tsx#L151) · [Repository link guidance](docs/maintainers/review-guidelines.md)                                                                                                         |
| F11 | **Color tokens undershoot the design's normal-text contrast requirement.**         | The code renders small amber, emerald and slate status text in the default white card theme. From bundled Tailwind OKLCH values converted to linear sRGB, the foreground-to-white ratios are approximately **2.15:1**, **2.46:1**, and **2.63:1** respectively. Each is below **4.5:1** before evaluating its component tint. The UI also dims dates to `text-muted-foreground/60` and makes them 9px. The presence of text badges and a source validator pass does not resolve the contrast failure. [Badge classes](src/client/features/fleet/FleetMatrixRow.tsx#L74) · [Date treatment](src/client/features/fleet/FleetMatrixRow.tsx#L230) · [Bundled theme surface](src/client/styles/app.css#L65) · [Design target](DESIGN.md#L86)                                                                                                                                                                                             |

### P3 nitpicks

| ID  | Finding                                                                             | Evidence and operator impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F12 | **The design and code inventory claim more than the current preview demonstrates.** | `CODEBASE.md` lists RPCs and UI names that do not exist, alongside material described as a roadmap. `DESIGN.md` claims a three-query warm read, screenshots and closed acceptance, but its evidence index points to a source component and its query count disagrees with F07. The supplied review's `FleetRosterModal` and `FleetErrorFallback` paths also do not exist. The actual alternatives are inline native disclosure plus shared `QueryState` and alerts. [Code inventory](CODEBASE.md#L228) · [Design verification](DESIGN.md#L211) · [Design evidence](DESIGN.md#L236) · [Error states](src/client/features/fleet/FleetOverviewView.tsx#L74) |
| F13 | **Four fleet-wiring files fail the repository's Prettier check.**                   | Scoped formatting identified `src/db/d1/schema.ts`, `src/db/pg/schema.ts`, `src/db/schema.ts` and `src/lib/org-permissions.ts`. The separate lint and Knip failures listed in the evidence table are outside fleet changes. [D1 barrel](src/db/d1/schema.ts) · [PG barrel](src/db/pg/schema.ts) · [Provider-aware barrel](src/db/schema.ts) · [Permissions](src/lib/org-permissions.ts)                                                                                                                                                                                                                                                                  |

### Accessibility touchpoints in the design contract

| Principle              | Stage 1 source observation                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fitts's Law            | Sort, audit and toolbar controls use `min-h-9`. Desktop evidence and mobile action discoverability are gaps in F10.                                         |
| Visual Hierarchy       | Header, overview cards, filters and matrix have a stable reading order. Triage priority within the matrix is missing.                                       |
| Von Restorff Effect    | Critical flags use a distinct badge and card. Text contrast and priority affect that emphasis. F10–F11.                                                     |
| Object Constancy       | Route uses the shared app shell and stable row keys for reordering within one roster. Target history across rosters needs F08.                              |
| Snapping               | The contracted N/A is consistent with a static table and no drag surface.                                                                                   |
| Motion Blur            | N/A is consistent with the absence of fast-motion UI.                                                                                                       |
| Natural Mapping        | Sorting buttons use direction icons and `aria-sort` on the active header. The visible click instruction should accommodate keyboard users.                  |
| Tabular Figures        | Matrix values are tabular. The card headlines lack that class despite the documented numerical typography.                                                  |
| Animate Only the Delta | React reorders keyed rows without a page transition. The source does not animate row-order deltas or update fleet-wide metrics when filters change.         |
| Inertia                | The scroll container uses native browser scrolling. The documented “smooth” behavior was not established from this source.                                  |
| Multimodal Feedback    | Filter buttons expose `aria-pressed` and the result count uses `role="status"`. Initial skeletons do not provide equivalent labelled loading feedback here. |
| Visual Cues            | Hover, focus and textual status labels are present. Contrast and tiny dates weaken the feedback. F11.                                                       |
| Skeuomorphism          | The flat dashboard matches the documented N/A.                                                                                                              |

## Implementation pointers and regression checks

The following changes are ordered so the storage contract is established before readers or tests depend on it. Snippets specify the required behavior and target interfaces. The proposed patches were not applied to the checkout.

### 1. Make roster provisioning runnable and auditable

#### F01 · Use a Node entry point with an explicit database connection

1. Extract only the approved-roster write unit from `FleetRepository`. Pass it the schema tables and its transaction executor, or pass a narrowly scoped roster store with `findVersion(orgId, versionTag)`, `listActiveProjects(orgId)` and `insertVersionWithMembers(version, members)`. Keep Worker imports out of this module's runtime graph.
2. In `scripts/import-fleet-roster.ts`, parse arguments first. Follow `scripts/seed-projects.ts` with direct SQLite schema imports, `getPlatformProxy({ remoteBindings: false })`, `drizzle(env.DB)` and one awaited D1 batch. Use `dispose()` in `finally`. Require the target organization and the approval payload described in F05. Explicitly document local D1 as the supported CLI target. If the same command must also provision local PostgreSQL, use a separate explicit Node `postgres` connection and `db.transaction` with the PG tables. Close it in `finally`. The Worker keep-alive wrapper cannot supply Node CLI context.
3. Keep the transaction atomic for version and member rows. Exercise the real command in an isolated persistence directory, then reopen the same database and verify the result. Inject an ordinary row constraint failure and confirm neither version nor member rows commit.

```ts
// Inside async main() in scripts/import-fleet-roster.ts.
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: pnpm exec tsx scripts/import-fleet-roster.ts <orgId> --approval <file>",
  );
  return;
}
const input = parseRosterArgs(args);
const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>({
  remoteBindings: false,
});
try {
  const db = drizzle(env.DB);
  await importRoster(input, makeLocalRosterStore(db));
} finally {
  await dispose();
}
```

Copy-ready smoke test for the existing documented command. It currently exits 1 before running the usage branch.

```powershell
$usage = pnpm exec tsx scripts/import-fleet-roster.ts --help 2>&1
if ($LASTEXITCODE -ne 0 -or ($usage -join ' ') -notmatch 'Usage:.*import-fleet-roster') {
  throw "Fleet roster CLI did not load and print usage"
}
```

#### F05 · Bind a canonical payload to the exact approved organization and version

1. Use Zod to validate the approved file with shared enums, normalized bare hostnames, unique canonical and alias assignments, explicit enrollment, and approved project ID or null. Include organization, version tag, approval actor/time, aliases and the mapping in the canonical payload. Use the verified 87-host count for this manifest version. Reject unknown values. Keep legacy source catalog fields outside the approved payload if they are unused. A parked member can remain in scope. Exclusions belong outside the enrolled roster.
2. Generate a mapping proposal from active same-org project IDs. Require resolution of ambiguous matches before approval. Persist approved IDs exactly, with no implicit choice during import. Version changes to mappings. Convert JSON to a fixed projection with members sorted by canonical hostname and aliases sorted by hostname. Use ordinal ordering, stable property order, compact UTF-8 JSON and SHA-256. An owner-approved file with the digest is enough for the offline review contract. Preserve approval provenance alongside it.
3. Look up the exact `(organizationId, versionTag)` on both normal and race paths. Require digest equality on every replay. On an insertion failure, return the existing ID only after the same-tag check proves an equal digest. Convert a different or blank digest to `CONFLICT` and rethrow the original error if the exact tag never committed. Keep “latest approved” as a separate read using valid UTC times only. Use an explicit tie-break when approval clocks match.

```ts
async function verifiedReplay(
  orgId: string,
  tag: string,
  expectedHash: string,
) {
  const existing = await store.findVersion(orgId, tag);
  if (!existing) return null;
  if (existing.manifestHash !== expectedHash) {
    throw new AppError("CONFLICT", "Roster version hash mismatch");
  }
  return existing.id;
}

const replay = await verifiedReplay(
  input.organizationId,
  input.versionTag,
  hash,
);
if (replay) return replay;
try {
  await store.insertVersionWithMembers(version, members);
  return version.id;
} catch (error) {
  const committed = await verifiedReplay(
    input.organizationId,
    input.versionTag,
    hash,
  );
  if (committed) return committed;
  throw error;
}
```

After F01 adds `importRoster(input, store)`, use the disposable DB fixture in the CLI test. Run the same behavior against both supported transaction adapters if both are shipped. The pre-fix equivalent in `seedApprovedRoster` looks up the latest row and fails the identical replay case.

```ts
it("replays the requested older tag and rejects changed bytes", async () => {
  const v1 = approvedRoster({
    versionTag: "v1",
    approvedAt: "2026-11-20T00:00:00Z",
  });
  const v2 = approvedRoster({
    versionTag: "v2",
    approvedAt: "2026-11-21T00:00:00Z",
  });
  const id = await importRoster(v1, store);
  await importRoster(v2, store);

  await expect(importRoster(v1, store)).resolves.toBe(id);
  const changed = approvedRoster({
    ...v1,
    members: v1.members.map((m, i) =>
      i === 0 ? { ...m, category: "Changed" } : m,
    ),
  });
  await expect(importRoster(changed, store)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect((await store.findVersion(v1.organizationId, "v1"))?.id).toBe(id);
});
```

Have `approvedRoster` return a fresh validated fixture with the digest computed from its supplied values, and use real DB rows for `findVersion`. Also run same-tag concurrent replays, duplicate normalized hosts, two hostnames assigned to one project, an archived project and incorrect org input. Assert row counts and stable IDs after reopening the target database.

### 2. Align persisted evidence, chronology and grading

#### F02 · Persist the series and the complete comparison signature

1. Add nullable `seriesKey` and `comparabilityKey` to both snapshot schemas and migrations so legacy points can be identified. The write boundary must supply nonempty values for new points. Set series names explicitly, for example `weekly-baseline` and `diagnostic`. Backfill only from verified metadata. An unverifiable legacy point has no delta.
2. Hash a fixed ordered tuple containing signature format version, rubric, target identity, panel hash, applicability/weights hash, collector versions, collection profile and source scope. Canonicalize structured inputs before assembly. Deployment revision may change between comparable measurements. Validate project and tenant at the read boundary.
3. Form the headline from weekly baseline observations. In the same series, choose the immediately preceding graded observation, then check the whole signature and the inclusive 21-day gap. If incompatible, return a typed reason alongside the null delta. Keep genuine zero distinct. A diagnostic observation must not displace the weekly predecessor.

```ts
const comparisonKey = createHash("sha256")
  .update(
    JSON.stringify([
      "fleet-comparison-v1",
      rubricVersion,
      targetIdentity,
      panelHash,
      applicabilityWeightsHash,
      collectorVersions,
      profileIdentity,
      sourceScope,
    ]),
  )
  .digest("hex");

// points contains lineage-validated official points in observation order, newest first.
if (current.seriesKey !== "weekly-baseline")
  return { delta: null, reason: "series" };
const prior = points.find(
  (p) =>
    p.seriesKey === current.seriesKey && p.observedAtMs < current.observedAtMs,
);
if (!prior) return { delta: null, reason: "no_prior" };
if (current.observedAtMs - prior.observedAtMs > COMPARABLE_BASELINE_WINDOW_MS) {
  return { delta: null, reason: "time_gap" };
}
if (
  !current.comparabilityKey ||
  current.comparabilityKey !== prior.comparabilityKey
) {
  return { delta: null, reason: "method_changed" };
}
return {
  delta: Math.floor(current.score) - Math.floor(prior.score),
  reason: null,
};
```

Replace the integration case at line 255 with the regression below. In the fixture, write `rubricVersion: options.rubric ?? "v1"` to `fleetRuns` and separately insert `seriesKey` and `comparabilityKey` into the snapshot after the schema change. Allow nullable keys in the fixture options. Delete the `_compKeys` side channel. Set valid fixture pillars to the expected score when F04 lands.

```ts
it.each([
  ["same panel", "a", 6],
  ["changed panel, same rubric", "b", null],
  ["unverified legacy signature", null, null],
] as const)(
  "uses persisted comparison metadata: %s",
  async (_label, currentKey, expected) => {
    await attempt("weekly-prior", "completed", baseline, {
      score: 85,
      rubric: "v1",
      seriesKey: "weekly-baseline",
      comparabilityKey: "a",
    });
    await attempt("diagnostic", "completed", earlier, {
      score: 95,
      rubric: "v1",
      seriesKey: "diagnostic",
      comparabilityKey: "x",
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
```

Preserve same-signature zero delta. Assert the time window at exactly 21 days and one millisecond beyond. Cover panel, profile, source, collector and applicability changes at the signature producer, with the persisted test above establishing that the consumer uses the output.

#### F03 · Select current evidence before deciding whether it qualifies

1. Scope items to the approved project and series. Order terminal attempts by valid completion time and remove missing, malformed and future clocks from controlling selection. Use a deterministic tie-break. Keep active status as an overlay. A failed latest terminal item sets unavailable and retains last good. Skips and cancellations cannot create a grade.
2. Select the newest valid completed or partial baseline observation by `observedAt` independently. Pass that raw observation through grading. Keep incomplete evidence visible when an older official point exists. For a latest partial attempt, preserve that status and its own observation if present. A completed attempt without a snapshot needs an incomplete-evidence reason. Its completion time cannot stand in for an observation timestamp.
3. Derive `lastGood` from independently qualifying historical points and exclude it from current coverage, trend and fleet aggregates. Return `latestAttemptAt` and `lastObservedAt` separately. Preserve ordering when an older observation arrives after a newer one.

```ts
const terminal =
  scopedAttempts
    .flatMap((item) => {
      const completedAtMs = parseUtcTimestampMs(item.completedAt);
      return isTerminalFleetAttempt(item.status) &&
        Number.isFinite(completedAtMs) &&
        completedAtMs <= now
        ? [{ item, completedAtMs }]
        : [];
    })
    .sort(
      (a, b) =>
        b.completedAtMs - a.completedAtMs || b.item.id.localeCompare(a.item.id),
    )[0]?.item ?? null;

const latestObserved =
  orderedValidBaselineSnapshots.find(
    (s) => s.attemptStatus === "completed" || s.attemptStatus === "partial",
  ) ?? null;
const currentSnapshot =
  terminal?.status === "partial"
    ? (orderedValidBaselineSnapshots.find((s) => s.runItemId === terminal.id) ??
      null)
    : latestObserved;
const currentPoint = currentSnapshot
  ? officialPoint(currentSnapshot, approvedProjectId, now)
  : null;
// Derive unavailable, stale, fresh_partial or fresh_graded from this state.
// Evaluate lastGood separately from currentPoint.
```

Copy into the existing SQLite integration suite against current code. Add `omitAiOnly?: boolean` to the `attempt` fixture and set only `scoreAiReadiness: null` for that option. Both assertions failed under the equivalent standalone SQLite-backed service probe.

```ts
it("keeps newer incomplete evidence visible beside the historical grade", async () => {
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

it("ignores terminal rows whose completion clock is in the future", async () => {
  await attempt("good", "completed", baseline, { score: 85 });
  await attempt("future", "failed", "2026-11-23T00:00:00Z");
  expect(await row()).toMatchObject({ status: "fresh_graded", score: 85 });
});
```

Run these with the existing older-observation-later-completion, other-project failure, intervening partials and failed latest cases. Add a completed-without-snapshot case and assert the distinct reason. Determine whether the existing valid observation remains eligible from its own clock and lineage.

#### F04 · Reconcile the official score and preserve evidence precision

1. Use nullable double-precision score and interval endpoints in both dialects, with SQLite `real` and PostgreSQL `doublePrecision`. Make coverage explicitly nullable for unknown and remove the implicit 100 default. Use one agreed quantization at the write boundary or exact fixed-point units if rule inputs require exact reconciliation. Round only at display. Keep unverified legacy evidence ungraded.
2. Put the PRD weights in one registry used by the evaluator, fixtures and display labels. In the official predicate require complete evidence, valid finite pillars, valid observation, completed attempt and same project. Compute the weighted composite, then apply the policy cap of 59 for a confirmed incident. Reject inconsistent stored scores from current and last good. Derive the letter from the same canonical score. Establish completeness from evidence, separate from the rounded coverage percentage.
3. For coverage from 80 through less than 100, compute the provisional interval from the versioned observed rule weights. With observed contribution `L = Σ(w × s) / 100` and known coverage `C`, set `U = L + 100 - C`. Apply a confirmed cap to each bound. Use measured rule weights when a pillar is partially observed. If those inputs are absent, return known coverage and valid pillars with no interval. Return null for invalid values. Keep the critical flag visible on qualifying partial evidence without upgrading its grade.

```ts
const weights = {
  technical: 35,
  mobilePerf: 15,
  schema: 10,
  onPage: 15,
  ai: 5,
  links: 20,
} as const;
const uncapped =
  (p.technical * weights.technical +
    p.mobilePerf * weights.mobilePerf +
    p.schema * weights.schema +
    p.onPage * weights.onPage +
    p.ai * weights.ai +
    p.links * weights.links) /
  100;

const raw = snapshot.hasIncidentCap ? Math.min(59, uncapped) : uncapped;
const score = roundToPersistedPrecision(raw);
if (snapshot.score !== score || snapshot.grade !== gradeFor(score)) return null;
return { score, grade: gradeFor(score), observedAtMs };

// Only at the display boundary:
const headline = Math.floor(score);
```

Copy into the SQLite integration suite. Add `pillarScore?: number` and `grade?: FleetGrade` to `attempt`. Persist the explicit grade and set all populated pillars to `options.pillarScore ?? score`. Assert that rejects stay out of the fleet median and that valid zero remains graded.

```ts
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
] as const)("reconciles $stored against six $pillar pillars", async (c) => {
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
```

Verify the PRD's 68→82→85 example, a cap crossing, the 80% interval threshold, fractions on either side of a letter boundary, and missing or invalid data. Reconcile method, raw score, display floor and grade through one persisted round trip on each dialect.

### 3. Harden reads and persistence

#### F06 · Enforce parent lineage and unique logical points

1. Add tenant/version columns where needed and unique reference tuples for `(organization_id, id)` on roster versions and `(organization_id, roster_version_id, id)` on members and runs. Have each item reference both parent tuples. Where `project_id` is nullable, use a separate same-tenant project FK with an explicit archive and hard-delete policy. Rehearse migrations with existing null links before changing `SET NULL` behavior.
2. Derive snapshot lineage through the run item. When keeping redundant columns for indexes, enforce equality with a composite FK and explicit nullable-project semantics. Keep non-null project assignments unique within the roster. Enforce one point per run item, series and rubric. Require verified lineage for issue and change evidence before wiring those writes.
3. Prepare forward migrations if either fleet schema has already been applied. Run valid and invalid lineage, duplicate-point rejection and optional-project teardown cases against real local SQLite and PostgreSQL. Assert the intended constraint on rejection. Keep boundary filtering during rollout and test it separately with an explicit legacy fixture if it protects older imported data.

```sql
CREATE UNIQUE INDEX fleet_roster_version_project_uq
  ON fleet_roster_members (version_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX fleet_snapshot_logical_point_uq
  ON fleet_snapshots (run_item_id, series_key, rubric_version);
```

The snapshot index assumes F02's series column and a snapshot rubric column populated from its parent at publication. Backfill verified metadata and reconcile known duplicates before imposing uniqueness. Require new points to provide both fields so SQL null semantics cannot bypass the index.

#### F07 · Fetch bounded, joined overview candidates

1. Select only public overview inputs. Join snapshot, item and authorized run in the same statement as their state selection. Keep lease tokens, internal error details and evidence keys off the overview query.
2. Add indexed, normalized UTC observation and completion order. Use a fixed small set of reads. Partition by stable target/project/series and select the newest valid terminal attempt, newest current observation even if ungraded, latest official and its immediate earlier official point. Filter the official partition using the scoring invariant before ranking. Verified publication state avoids duplicating the arithmetic predicate in SQL. A generic cutoff before that filter can discard last good.
3. Check both SQL plans locally with 87 targets, 104 weeks, partials in front of valid history and timestamp ties. Assert bounded result rows, preserved last good and the right predecessor. Record the local statement count alongside the fixture size in `DESIGN.md`.

```sql
SELECT id, run_item_id, observed_at_ms
FROM fleet_snapshots
WHERE organization_id = :organization_id
  AND target_id = :target_id
  AND project_id = :project_id
  AND series_key = 'weekly-baseline'
  AND publication_state = 'official'
  AND observed_at_ms < :current_observed_at_ms
ORDER BY observed_at_ms DESC, id DESC
LIMIT 1;
```

Use this as a correlated lookup inside the organization-scoped roster statement, with bind parameters for the organization and active roster and outer values for target, project and current time. Add an index on `(organization_id, target_id, project_id, series_key, publication_state, observed_at_ms DESC, id DESC)`. Obtain the latest official and latest raw snapshot as separate indexed lookups, and do the same on the indexed attempt table. If redundant indexed identity columns are needed, constrain them per F06. With that structure an overview need not transfer historical row sets or rank the entire history on each read.

#### F08 · Separate target identity from version membership

1. Add or reuse an immutable tenant-scoped target ID for the approved canonical property. Let each roster membership reference the stable target while retaining the version ID. Use a reviewed mapping for historic target IDs and retain archived identities.
2. Read old points for the same stable target and still-approved project. Continue a series only when F02's signature permits it. Preserve historical version IDs and derive the current denominator from current memberships. A changed project with no accepted continuity starts without an official baseline.
3. Test an unchanged host/project across two roster versions and a second fixture where the link changes. Assert visible last good in the first case and no stale project score in the second.

```sql
JOIN fleet_roster_members active
  ON active.version_id = :active_version_id
 AND active.organization_id = i.organization_id
 AND active.target_id = i.target_id
 AND active.project_id = i.project_id
```

#### F09 · Verify entitlement at the registered server-function boundary

1. Preserve the server's allowlisted organization and flag check before the fleet read. Exercise the locally registered TanStack handler with the real auth middleware and error translator, substituting the underlying identity/session dependency and fleet storage. Cover unauthenticated identity, no hosted membership, wrong workspace, missing flag, missing configured org, mismatching expected org, invalid role and actual `member`, `admin` and `owner`. Assert no fleet read on denial and one exact-org read on grant.
2. Assert the serialized public error code for expected denial and an unexpected storage exception. Confirm the exception's internal message stays out of the client result.
3. Document the owner-only Access policy and its delegated roles. For any shared Access workspace that needs reader/operator separation, resolve entitlement from a verified principal membership or dedicated fleet permission lookup. Keep that server decision independent of caller IDs. Use a server-derived can-view bit to hide unavailable navigation entries. Leave the feature off by default in local no-auth mode.

```ts
// After exercising the real dispatcher with a denied fixture:
expect(serializedError).toMatchObject({ message: "FORBIDDEN" });
expect(fleetRead).not.toHaveBeenCalled();

// In the permission fixture:
expect(hasOrgPermission("member", { fleet: ["view"] })).toBe(true);
expect(hasOrgPermission("admin", { fleet: ["view"] })).toBe(true);
expect(hasOrgPermission("guest", { fleet: ["view"] })).toBe(false);
```

### 4. Close the presentation, documentation and style findings

#### F10 · Expose the same evidence at each width and prioritize triage

1. Make the initial sort critical flags first, negative comparable deltas next and host as the tie-break. Preserve user-selected header sorts and expose a labelled reset to triage order. Use “Select a header” in the instruction.
2. Remove `md:hidden` from the per-domain disclosure or add an equivalent desktop panel. Add all six pillars, latest attempt and observation dates, and a directly discoverable mobile audit link. Reuse the existing TanStack link composition. Keep the desktop action cell. Use the project's existing safe external link helper after host validation and retain readable text when no usable link exists.
3. Return coverage as `number | null` so 0% remains real evidence. Use `<time dateTime>` with valid UTC timestamps, displayed in Asia/Jakarta. Give the initial skeleton a labelled loading status. Mark decorative emoji as hidden from assistive tech and keep each category name.

```tsx
<details>
  <summary className="min-h-9">Evidence for {domain.canonicalHost}</summary>
  <p>
    Coverage: {domain.coverage === null ? "—" : String(domain.coverage) + "%"}
  </p>
  {domain.lastObservedAt && (
    <p>
      Observed <time dateTime={domain.lastObservedAt}>{observedLabel}</time>
    </p>
  )}
  {/* Existing pillar content and labelled audit link */}
</details>
```

Verify a local rendering fixture for disclosure and keyboard action, all six labels, measured zero versus unknown, sort semantics, and critical/adverse default priority. Preserve null-last ordering for explicit score sorts.

#### F11 · Put high-contrast text on a known surface

1. Use `text-card-foreground` for grade and status text on the card. Use variant colors for decorative dots or borders. Use full-opacity, readable date text and tabular figures for card numbers. Provide explicit accessible labels for unavailable, improved, declined and unchanged trend.
2. Calculate the color pairs for both themes, including any tint, focus treatment and inherited opacity. The current neutral card foreground pairs calculate to approximately 18.10:1 in light and 13.33:1 in dark. Use 4.5:1 as the minimum for normal-sized text and the documented stronger target where applicable.

```tsx
<Badge variant="outline" className="text-xs text-card-foreground">
  <span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />
  Partial
</Badge>
<time dateTime={lastGoodAt} className="text-xs tabular-nums text-card-foreground">
  {lastGoodLabel}
</time>
```

#### F12 · Record the implemented preview and current evidence

1. In `CODEBASE.md` `7, list the actual route, RPC, components and CLI entry after F01. Mark remaining PRD operations as planned and preserve historical ledgers as dated records.
2. In `DESIGN.md` P-01, match actual labels, disclosure behavior and `aria-sort` placement. Replace unsupported readiness and query-count claims with reproducible local evidence. Keep live verification items in their Stage 2 entries.

```markdown
- Scope: private read-only roster and fleet overview.
- Implemented RPC: `getFleetOverview`. Project drill-down links to the existing audit route.
- Local evidence: design validator, focused Vitest and migration checks.
- Planned product slices: publisher, scheduling, historical evidence, export and remediation.
```

#### F13 · Format the four affected files

Format only the identified fleet wiring, then rerun the scoped and repository gates. Track the unchanged SERP cache and Windows suite failures independently.

```powershell
$files = @(
  "src/db/d1/schema.ts",
  "src/db/pg/schema.ts",
  "src/db/schema.ts",
  "src/lib/org-permissions.ts"
)
pnpm exec prettier --write @files
pnpm exec prettier --check @files
git diff --check
```

### Stage 1 re-review order

| Slice                                        | Local exit evidence                                                                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roster and replay, F01/F05                   | Actual CLI help and local import work, restart reads the same mapping, identical old-tag replay returns the original ID, drift is a typed conflict, and failed inserts leave no partial roster.                                    |
| Accounting and clocks, F02–F04               | Real persisted comparison dimensions, newest observation and latest attempt independently visible, arithmetic reconciles to fixtures, and only valid fresh official points contribute to published metrics.                        |
| Persistence, query and entitlements, F06–F09 | Both isolated migration/adapter runs pass lineage and chronology assertions. The full-size fixture proves bounded materialization and correct history across rosters. Registered RPC cases test deny, grant and error translation. |
| Presentation and maintenance, F10–F13        | Operator evidence is reachable at both layouts, measured zero and unknown remain distinct, semantic and contrast fixtures pass, docs match the checkout, and fleet-scoped formatting and static checks pass.                       |

For the next score, apply the same six vectors and local preview scope. Require zero open P0/P1 findings and reproducible evidence for the same contract before accepting at 9.5 or higher. A 10.0 requires all of the preview checks above to pass locally.
