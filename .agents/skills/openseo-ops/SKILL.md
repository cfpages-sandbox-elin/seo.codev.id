---
name: openseo-ops
description: "Sovereign operational skills for OpenSEO (seo.codev.id) on Cloudflare Workers edge. Governs fleet observability (/onsite), approved roster synchronization (import-fleet-roster, link-github-fleet), full-depth dual-lane site audits (commit-pinned GitHub Direct Audit Engine & edge SiteAuditWorkflow), D1 migrations, Alchemy v2 deployments, DataForSEO BYOK cost tracking, and programmatic Model Context Protocol (MCP) execution across all 78 registered tools."
metadata:
  author: Syamsul Alam & Gemini 4 Hydrogen
  version: "1.7.1"
  internal: true
---

# OpenSEO Operational Skills (`openseo-ops`)

**Canonical Skill Location:** `%OneDrive%\MD\SKILLS\openseo-ops\SKILL.md`  
**Target Platform:** OpenSEO (`https://seo.codev.id`)  
**Active Repository:** `C:\Users\THINKPAD\Documents\GitHub\seo.codev.id` (Branch: `main`)  
**Deployment Infrastructure:** Cloudflare Workers & Pages via Alchemy v2  
**Target Organization:** `shared-workspace`  
**Primary Database:** Cloudflare D1 `open-seo-db-selfhost` (UUID: `b11700fc-47e9-4eb3-a323-a024d7a2fbaa`)  
**Auxiliary Audit Worker:** `open-seo-selfhost-audit` (Engine for `SiteAuditWorkflow` & `AuditScratchpad` DO)  

---

## 1. System Topology & Dual-Worker Architecture

OpenSEO on `seo.codev.id` operates on an edge-native, decoupled dual-worker topology deployed through **Alchemy v2**:

```mermaid
flowchart LR
    App[App Worker: open-seo-selfhost] --> DB_R2_KV[Shared D1, R2, and ordinary KV]
    Audit[Aux Worker: open-seo-selfhost-audit] --> DB_R2_KV
    App --> OAuthKV[App-only OAuth KV]
    App -->|Workflow and AUDIT_ENGINE| Audit
    Audit --> Scratchpad[Per-audit SQLite DO: AuditScratchpad]
    Audit --> Browser[Cloudflare Browser Run]
```

### 1.1 App Worker (`open-seo-selfhost`)
- Handles incoming user requests, TanStack Router server-side rendering, and `/onsite` Aggregated Fleet View.
- Serves the native MCP endpoint at `https://seo.codev.id/mcp` with **78 registered tools** across 8 capability families.
- Authenticated at the edge:
  - **Self-Hosted Production (`AUTH_MODE=cloudflare_access`)**: Protected by Cloudflare Zero Trust Access Google SSO (Tier 1 Owner-Only). Browser users sign in via Google OAuth. Headless MCP clients authenticate by passing an authenticated session token via cookie (`Cookie: CF_Authorization=<token>`). Cloudflare Access edge verifies this session and passes the signed JWT assertion (`Cf-Access-Jwt-Assertion` containing valid `sub` and `email` principals) to the origin Worker. Cloudflare Access Service Tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) are accepted when a dedicated Service Auth policy and user-principal mapping are enabled.
  - **Local Development / Test Runner (`AUTH_MODE=local_noauth`)**: Trusted local no-auth environment on `localhost:3000` or in-memory mocks.
  - **Hosted Production Mode**: Authenticated via personal API keys (`oseo_...` via `Authorization: Bearer <key>` or `x-api-key`) or OAuth bearer tokens.
- App worker exclusively binds `OAUTH_KV` (`open-seo-oauth-kv-selfhost`) for MCP client registrations and OAuth refresh tokens.

### 1.2 Auxiliary Audit Worker (`open-seo-selfhost-audit`)
- Runs the heavy crawl and Lighthouse workflows isolated from the main app to prevent isolate memory exhaustion (OOM) on large sites.
- Implements `SiteAuditWorkflow` and the `AuditScratchpad` SQLite-backed Durable Object.
- Shared storage: Binds to the same D1 (`open-seo-db-selfhost`), R2 (`open-seo-r2-selfhost`), and KV (`open-seo-kv-selfhost`) as the main app.
- Owns the `BROWSER` binding (Cloudflare Browser Run) for rendered audits. Takes no direct public traffic (`url: false`).

---

## 2. Fleet Management & Aggregated Fleet Observability (`/onsite`)

The Aggregated Fleet View provides helicopter observability across Syamsul Alam's portfolio of **87 commercial properties**.

### 2.1 Database Schema for Fleet Management
Fleet state is partitioned across 10 dedicated D1 tables in `src/db/fleet.schema.ts`:
1. `fleet_roster_versions`: Version-controlled manifest snapshots (`id = 'roster-shared-workspace-2026-11-22-v1'`).
2. `fleet_roster_members`: The 87 canonical properties, bound by `canonical_host`, `category`, `tier`, `site_intent`, and `project_id`.
3. `fleet_runs`: Records fleet-wide audit batches and runs (`requester_id` NOT NULL).
4. `fleet_run_items`: Individual domain audit evaluation tasks within a run (`primary_series_key = 'diagnostic'` or `'weekly-baseline'`).
5. `fleet_snapshots`: Stored scoring snapshots and subscore pillars (`series_key = 'diagnostic'` or `'weekly-baseline'`).
6. `fleet_rule_results`: Detailed granular rule pass/fail/unknown counts.
7. `fleet_issue_occurrences`: Fingerprinted issues grouped across URLs and shared templates.
8. `fleet_change_events`: Production deployment events and Git commit provenance.
9. `fleet_change_verifications`: Causal attribution (`pending`, `verified_improved`, `verified_regressed`, `inconclusive`, `expired`).
10. `fleet_remediation_jobs`: One-click remediation packets bound to sovereign skills.

### 2.2 Status Taxonomy & Badge Precedence
Every domain in `/onsite` displays one of 7 mutually exclusive status badges evaluated with strict precedence via `deriveDisposition` (`src/server/features/fleet/services/fleetCalculations.ts:276–345`):
```text
unmapped → exempt → unavailable → terminal partial (fresh_partial or stale)
  → no/mismatched observation (never_audited) → stale → fresh_graded or fresh_partial
```
1. `Unmapped`: Domain exists in `fleet_roster_members`, but `project_id` is NULL.
2. `Exempt`: Intentionally excluded from automated fleet crawls (e.g. Tier 4 parked domains).
3. `Unavailable`: Latest attempt failed, crashed, errored, or finalized without an admitted observation snapshot (`status: "unavailable"`). Displays score `—` (distinguished from measured 0%).
4. `Terminal Partial`: Audit completed with partial evidence coverage between $80\%$ and $<100\%$, displayed as provisional interval $[L, U]$.
5. `Never Audited`: Linked to an active project in `projects`, but no completed audit attempt exists.
6. `Stale`: Previous audit completed, but results exceed the 10-day TTL freshness window.
7. `Graded`: Audit completed with 100% evidence coverage within the 10-day TTL window (or provisional when partial coverage reconciles).

**Interval Display Contract**: Provisional interval $[L, U]$ is a rendering presentation rule displayed if and only if reconciled evidence coverage satisfies $80\% \le C < 100\%$. Full point scores require $C = 100\%$. Freshness evaluation (10-day TTL window) and unavailable precedence operate independently of interval display eligibility.

**Critical Incident Cap**: Requires qualified confirmation (`parseIncidentConfirmation` in `fleetEvidence.ts`) with essential failure codes (DNS failure, TLS failure, origin connection drops), verified expected intent, independent corroboration probe, and finite confirmation timestamps. Validated incidents cap the maximum score at **59 (F)** with a critical incident badge.

### 2.3 Canonical Rubric v1 Scoring Engine
Health scores (0–100) are evaluated across 6 weighted pillars matching source constants in `src/server/features/fleet/services/fleetConstants.ts`:

| Pillar | Weight | Schema Column in `fleet_snapshots` | Key Metrics Evaluated |
|---|---|---|---|
| **Technical** | 35% | `score_technical` | HTTP 4xx/5xx errors, redirect chains, canonical integrity, response time. |
| **Internal Links** | 20% | `score_internal_links` | Broken internal links, orphan pages, crawl depth $\le 3$, anchor text distribution. |
| **Mobile & Lab Perf** | 15% | `score_mobile_perf` | Pinned mobile Lighthouse profile: LCP (50%), CLS (30%), TBT (20%). |
| **On-Page SEO** | 15% | `score_on_page` | Title tags, meta descriptions, H1 hierarchy, thin content detection. |
| **Schema & Structured Data** | 10% | `score_schema` | JSON-LD schema validity, OpenGraph, Twitter Cards. |
| **AI Search Readiness** | 5% | `score_ai_readiness` | 40-word direct answers, answer-first chunking, factual grounding for GEO/AEO. |

**Series Separation**:
- `'weekly-baseline'`: Official production fleet score series shown on the `/onsite` dashboard.
- `'diagnostic'`: Isolated series for host-side GitHub Direct Audits, preserving baseline score integrity without polluting weekly historical trends.

---

## 3. Site Audit Operations: Dual-Lane Audit Model

OpenSEO operates on a **Dual-Lane Audit Architecture**:

### Lane 1: Commit-Pinned GitHub Direct Audit Engine (`run-github-fleet-audit.ts`) — Primary Source Diagnostic Lane
- **Purpose**: Rapid, high-volume static source inspection directly from GitHub repositories without Worker isolate memory ceilings.
- **Commit Pinning**: Resolves target branch to an immutable commit SHA (`gh api /repos/:owner/:repo/commits/:branch`). All Git tree queries and blob reads are bound to this commit.
- **Git Tree Discovery**: Retrieves up to 100,000 files in a single atomic call (`GET /repos/:owner/:repo/git/trees/:commitSha?recursive=1`). Fails fast if `truncated: true`.
- **Zero Edge Heap Pressure**: HTML parsing, heading extraction, meta tag inspection, and OpenGraph analysis execute host-side in Node.js, completely bypassing Cloudflare Workers Free Tier 128 MB isolate memory ceiling.
- **In-Memory Link Graph Validation**: Maps repository file paths to canonical served identities (including directory `/index.html` $\leftrightarrow$ `/` and extensionless routes). Resolves internal `<a href="...">` links against the known route set using unified route indexing and apex/www equivalence to detect broken links and orphan pages with zero network calls.
- **Staged D1 Persistence**:
  1. Inserts parent audit in `running` phase with `github-audit-${auditId}` instance ID.
  2. Ingests pages and issues in bounded $\le 10$-statement chunks ($\le 15,000$ bytes total per batch envelope, strictly respecting Windows CreateProcessW 32,767 character limits).
  3. Reconciles child row counts in atomic compare-and-set UPDATE with `RETURNING id` (`WHERE id = :id AND status = 'running' AND (SELECT COUNT(*) FROM audit_pages WHERE audit_id = :id) = :pages AND (SELECT COUNT(*) FROM audit_issues WHERE audit_id = :id) = :issues`).
  4. On count mismatch or state conflict, throws immediately. Incomplete source acquisition ends with audit status `failed` and an isolated diagnostic item which can be `partial` (they are distinct).
- **Diagnostic Fleet Series Integration**: Writes `fleet_runs` (`requester_id = 'github-audit-runner'`), `fleet_run_items` (`primary_series_key = 'diagnostic'`), and `fleet_snapshots` (`series_key = 'diagnostic'`, unmeasured pillars `NULL`). Reused audits verify the full exact triple (`fleet_runs`, `fleet_run_items`, `fleet_snapshots`) with deterministic latest ordering and original-ID binding; repair failures abort without falling back to a redundant Git crawl.
- **Evidence Boundary**: Records source-only evidence. Unmeasured runtime properties (`status_code`, `response_time_ms`, `crawl_depth`) remain `NULL` and `in_sitemap` is `0`. Runtime-only issue reporters (`deep-page`, `slow-response`) are excluded.

### Lane 2: Edge HTTP Workflow Crawler (`SiteAuditWorkflow`) — Live Runtime & Fleet Grading Lane
- **Purpose**: Full live HTTP validation, external third-party crawls, robots.txt enforcement, and real edge TTFB latency measurement. (Note: neither `run-fleet-audits.ts` nor `run_site_audit` publishes official weekly fleet snapshots; official weekly baseline grading is reserved for dedicated aggregate grading publishers).
- **Control Plane (`SiteAuditWorkflow`):** Cloudflare Workflow managing phase ordering, retries, and failure states on `open-seo-selfhost-audit`.
- **Data Plane (`AuditScratchpad`):** SQLite-backed Durable Object instance per audit (`idFromName(auditId)`). Manages URL frontier leases in chunks of up to 100 URLs.
- **Limits & Defaults**: Edge crawler defaults to 500 pages (max 10,000 for self-hosted instances) and concurrency 2 (allowed range 1–5), requiring exactly one execution scope (`--domain`, `--all`, or `--limit`). When the 15-minute polling deadline is exceeded on in-flight audits, admission pauses to protect concurrency slots until workflows terminate. JavaScript-rendered crawls up to 1,000 pages (`RENDERED_MAX_AUDIT_PAGES`) via Cloudflare Browser Run.

---

## 4. Operational Playbooks: Fleet & Site Audit

### Playbook 1: Roster Enrollment & Turnkey Linking
**Prerequisites**:
- The parent organization row (`id = 'shared-workspace'`) must exist in D1 before importing rosters to satisfy foreign key constraints.
- Approval JSON requires canonical schema fields: `organizationId`, `versionTag`, `rosterPlanSha256`, and `approvedBy`.
- Roster importing (`import-fleet-roster.ts`) targets local D1 via `--approval`. Remote fleet linking (`link-github-fleet.ts`) requires an existing effective approved roster. Always run `--dry-run` to preview plans before live execution.

For fresh **local development** (`localhost:3000` / `wrangler dev`):
```powershell
# 1. Apply local migrations to local D1 (DB)
pnpm exec wrangler d1 migrations apply DB --local

# 2. Import approved roster into local D1
$approvalFile = "path/to/approval.json"
pnpm exec tsx scripts/import-fleet-roster.ts shared-workspace --approval "$approvalFile"

# 3. Preview turnkey linking plan (validates unmapped projects and calculates required links)
pnpm exec tsx scripts/link-github-fleet.ts --dry-run

# 4. Execute turnkey linking against local D1
pnpm exec tsx scripts/link-github-fleet.ts
```

For **remote production D1** (`open-seo-db-selfhost` on Cloudflare edge):
```powershell
# Preview turnkey fleet linking plan across all portfolio targets and roster members (dry-run)
pnpm exec tsx scripts/link-github-fleet.ts --remote --dry-run

# Execute turnkey fleet linking against live remote D1 with post-apply roster supersession checks
pnpm exec tsx scripts/link-github-fleet.ts --remote
```

> [!NOTE]
> The linker's `--dry-run` flag operates as an execution plan preview that computes missing projects and link updates without mutating D1. Full database integrity assertions (zero unmapped, zero invalid links) and post-apply roster supersession checks run on live execution passes to confirm state convergence.

### Playbook 2A: Executing Commit-Pinned GitHub Repository Audit (Primary Source Lane)
Direct audit accepts exactly one execution scope (`--domain <canonical-host>`, `--limit <n>`, or `--all`). By default, bulk audit admits properties from the approved fleet roster; pass `--workspace` to audit wider inventory projects. Use `--force` to run a fresh source audit at the repository's current pinned revision; without it, completed source audits with verified diagnostic observations are reused or scheduled for diagnostic repair. D1 target defaults to `--remote` (`open-seo-db-selfhost`); pass `--local` for local D1 (`DB`).
```powershell
# Audit a single property by exact domain directly from its GitHub repository (Selective Blob Lane)
pnpm exec tsx scripts/run-github-fleet-audit.ts --domain concrete.co.id --force

# Streamed tarball archive mode for repositories without heavy binary assets
# (Enforces 100 MiB compressed, 250 MiB expanded, and 10 MiB per-entry caps with verified raw fallback)
pnpm exec tsx scripts/run-github-fleet-audit.ts --domain concrete.co.id --archive --force

# Local D1 execution pass
pnpm exec tsx scripts/run-github-fleet-audit.ts --domain concrete.co.id --local --force

# Benchmark Selective Blob vs. Tarball Archive lane performance with verified blob acquisition
# (Covers archive acquisition, entry extraction, and raw fallback recovery with verified wire bytes)
pnpm exec tsx scripts/benchmark-archive-audit.ts --domain concrete.co.id
pnpm exec tsx scripts/benchmark-archive-audit.ts --repo cfpages-adistyputriharli/Concrete.co.id

# Audit a bounded slice of candidate portfolio properties (limits both repairs and fresh audits)
pnpm exec tsx scripts/run-github-fleet-audit.ts --limit 20

# Audit wider workspace inventory outside approved fleet roster
pnpm exec tsx scripts/run-github-fleet-audit.ts --all --workspace
```

### Playbook 2B: Triggering Edge Site Audits & Batch Fleet Crawls (Live Runtime Lane)
For live HTTP validation across deployed sites, dispatch via the CLI edge runner, `AuditService.startAudit`, or MCP `run_site_audit`:

> [!NOTE]
> The edge runner (`run-fleet-audits.ts`) creates site-audit rows and dispatches the live crawler workflow. Output from edge crawls represents site-audit instances; official weekly baseline grading (`weekly-baseline` series) is reserved for dedicated aggregate grading publishers.
> Edge defaults: 500 pages, concurrency 2 (allowed range 1–5), exactly one scope. When the 15-minute polling deadline is exceeded on in-flight audits, admission pauses to protect concurrency slots until workflows terminate. When running locally, `--local` requires a running local dev session (`wrangler dev`). `--no-skip-recent` overrides the 10-day recency cutoff filter.

```powershell
# Run Cloudflare Workflows live HTTP crawler across target domain
pnpm exec tsx scripts/run-fleet-audits.ts --domain concrete.co.id --max-pages 500

# Run workflow crawler across candidate fleet projects with concurrency window (override recency check)
pnpm exec tsx scripts/run-fleet-audits.ts --limit 10 --concurrency 2 --no-skip-recent

# Local development dispatch (requires local dev session running)
pnpm exec tsx scripts/run-fleet-audits.ts --domain concrete.co.id --local
```

Programmatic dispatch via `AuditService.startAudit` (internal server call) or MCP input:

**Internal Server Call (`AuditService.startAudit`)**:
```typescript
await AuditService.startAudit({
  projectId: "<project-uuid>",
  startUrl: "https://concrete.co.id",
  actorUserId: "user_123",
  billingCustomer: {
    userId: "user_123",
    userEmail: "admin@codev.id",
    organizationId: "shared-workspace",
    projectId: "<project-uuid>",
  },
  limitTier: "self_hosted",
  maxPages: 2000,
  renderJavaScript: false,
  lighthouseStrategy: "none",
});
```

**MCP Tool Input Schema (`run_site_audit`)**:
```json
{
  "projectId": "<project-uuid>",
  "url": "https://<domain>/",
  "maxPages": 2000,
  "renderJavaScript": false,
  "runLighthouse": false
}
```

### Playbook 2C: Fleet-Wide Issue Triage & CSV Export
Queries the latest completed audit per active project, ordering by severity priority (critical $\rightarrow$ warning $\rightarrow$ info) then domain and issue ID:
```powershell
# List top aggregated issues across all fleet audits with sovereign skill routing (default limit 200, max 1000)
# Supports --local (local SQLite D1 fixture) or default remote D1 execution
pnpm exec tsx scripts/fleet-issues.ts --limit 50
pnpm exec tsx scripts/fleet-issues.ts --local --limit 50

# Filter issues by exact domain, severity, and issue type
pnpm exec tsx scripts/fleet-issues.ts --domain concrete.co.id --severity critical --type broken-internal-link

# Output formats: JSON payload or RFC 4180 CSV with formula escaping (when both --csv and --json are passed, --csv takes precedence)
pnpm exec tsx scripts/fleet-issues.ts --domain concrete.co.id --json
pnpm exec tsx scripts/fleet-issues.ts --csv fleet-issues.csv
```

### Playbook 2D: Programmatic Fleet Operations via MCP
```typescript
// Query fleet aggregated issues with skill routing (evaluates latest completed audit per active project)
// Limit parameter: default 50, permitted 1–200. Total issues and breakdowns count the returned, filtered sample.
const issuesResult = await client.callTool({
  name: "get_fleet_issues",
  arguments: { domain: "concrete.co.id", severity: "critical", issueType: "broken-internal-link", limit: 20 },
});

// Generate execution plan for fleet audit (emits structured argv; does not dispatch directly)
// Repository direct mode defaults to maxPages: 2000; Edge workflow mode forwards maxPages (default 500) and concurrency (1–5, default 2)
const auditPlan = await client.callTool({
  name: "run_fleet_audit",
  arguments: { domain: "concrete.co.id", mode: "edge_workflow", maxPages: 500, concurrency: 2 },
});
console.log("Execution argv:", auditPlan.structuredContent?.argv);
```

### Playbook 2E: Fleet Telemetry & Inventory Inspection
```powershell
# View fleet status summary with mutually exclusive coverage stats (completed, running, failed, never_audited)
# Supports --local or default remote D1 execution
pnpm exec tsx scripts/fleet-status.ts
pnpm exec tsx scripts/fleet-status.ts --local

# Check repository presence and default branch across all portfolio entries
pnpm exec tsx scripts/check-fleet-repos.ts
```
> [!NOTE]
> The coverage panel considers the latest attempt per active workspace project with a domain. The overall audit totals and recent audit samples include active workspace projects. A fresh partial status can result from a partial attempt or insufficient evidence for an official grade; an interval is rendered only when reconciled evidence satisfies 80% <= coverage < 100% and bounds agree with earned mass.

### Playbook 3: Monitoring Workspace Audit Execution in Remote D1
To inspect real-time crawler progress and audit state using workspace-scoped predicates:
```powershell
npx wrangler d1 execute open-seo-db-selfhost --remote --command "
  SELECT a.id, p.domain, a.status, a.pages_crawled, a.pages_total,
         a.error_code, a.current_phase, a.started_at 
  FROM audits AS a
  JOIN projects AS p ON p.id = a.project_id
  WHERE p.organization_id = 'shared-workspace' AND p.archived_at IS NULL
  ORDER BY julianday(a.started_at) DESC NULLS LAST, a.id DESC 
  LIMIT 10;
"
```

### Playbook 4: Self-Host Deployment Pipeline (Alchemy v2)
Every code mutation must be deployed to live production via the canonical package script:
```powershell
# Executes preflight validation, vite build --mode selfhost, typecheck, and alchemy deploy
pnpm run deploy:selfhost
```

### Playbook 5: Programmatic Headless MCP Client Operations
In self-hosted deployments (`AUTH_MODE=cloudflare_access`), headless agents connect using `StreamableHTTPClientTransport` with the authenticated session cookie lane:
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "openseo-fleet-operator", version: "1.0.0" }, { capabilities: {} });
const accessSession = process.env.CF_ACCESS_SESSION;
if (!accessSession) throw new Error("Missing Cloudflare Access session token (CF_ACCESS_SESSION)");

const transport = new StreamableHTTPClientTransport(
  new URL("https://seo.codev.id/mcp"),
  {
    requestInit: {
      headers: {
        // Authenticated Cloudflare Access Google SSO session token (cookie lane)
        Cookie: `CF_Authorization=${accessSession}`,
      },
    },
  }
);

await client.connect(transport);
try {
  // Discover available tools across all 78 registered tools
  const tools = await client.listTools();
  console.log(`Discovered ${tools.tools.length} MCP tools`);

  // Call list_projects within the admitted workspace
  const projects = await client.callTool({ name: "list_projects", arguments: {} });
  console.log("Active projects:", projects);
} finally {
  await client.close();
}
```

> [!NOTE]
> For origin service-to-service authentication, the worker verifier requires a signed `Cf-Access-Jwt-Assertion` header containing valid `sub` and `email` identity claims. For public client connections through Cloudflare Access edge, pass the authenticated session via the `Cookie: CF_Authorization=<token>` header. For local offline testing, use `http://127.0.0.1:8787/mcp` with `AUTH_MODE=local_noauth` (zero Access headers required).

---

## 5. Full OpenSEO Operator Surface Playbooks

### Playbook 6A: Rank Tracking Operations (`/rank-tracking`)
- **UI Route**: `/p/:projectId/rank-tracking`
- **MCP Tools**: `create_rank_tracker`, `add_rank_tracking_keywords`, `estimate_rank_tracker_cost`, `run_rank_tracker`, `get_rank_tracker`
- **Workflow**:
  1. Create tracker (project ID must be a valid UUID; capture returned `trackerId`):
     ```ts
     const createRes = await client.callTool({
       name: "create_rank_tracker",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         domain: "kaca.co.id",
         locationCode: 2360,
         languageCode: "id"
       }
     });
     const trackerId = createRes.structuredContent?.trackerId;
     if (!trackerId) throw new Error("Tracker creation did not return a trackerId");
     ```
  2. Estimate cost:
     ```ts
     const estResult = await client.callTool({
       name: "estimate_rank_tracker_cost",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         trackerId,
         additionalKeywords: ["kaca tempered surabaya", "partisi kaca"]
       }
     });
     // Quote fields reside strictly in structuredContent envelope (not SDK root)
     const costCredits = estResult.structuredContent?.costCredits;
     const scheduledCredits = estResult.structuredContent?.scheduledEstimate?.costCredits;
     ```
  3. Enroll keywords with operator approval for recurring scheduled check credits:
     ```ts
     await client.callTool({
       name: "add_rank_tracking_keywords",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         trackerId,
         keywords: ["kaca tempered surabaya", "partisi kaca"],
         maxEstimatedScheduledCheckCredits: scheduledCredits
       }
     });
     ```
  4. Trigger immediate tracking run with separately approved live run credits:
     ```ts
     await client.callTool({
       name: "run_rank_tracker",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         trackerId,
         maxCostCredits: costCredits
       }
     });
     ```
  5. Read results:
     ```ts
     await client.callTool({
       name: "get_rank_tracker",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         trackerId
       }
     });
     ```

### Playbook 6B: AI Search Visibility & Prompt Exploration (`/ai-visibility`)
- **UI Route**: `/p/:projectId/ai-visibility` and `/p/:projectId/prompt-explorer`
- **MCP Tools**: `save_ai_visibility_tracker`, `run_ai_visibility_check`, `get_ai_visibility_run`, `estimate_ai_visibility_cost`, `set_ai_visibility_schedule`
- **Workflow**:
  1. Estimate cost and present quote to operator:
     ```ts
     const estimate = await client.callTool({
       name: "estimate_ai_visibility_cost",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         patch: {
           engines: ["chatgpt", "perplexity"],
           prompts: [{ text: "kontraktor kaca terbaik surabaya" }]
         }
       }
     });
     // Inspect data quote envelope:
     const quote = estimate.structuredContent?.data;
     const perCheckUsd = quote?.costUsd;
     const monthlyUsd = quote?.monthlyCostUsd;
     const runNowUsd = quote?.runNowCostUsd;
     ```
  2. Explicit Operator Approval Gate: Require confirmation of nominal per-check and monthly recurring costs before saving or enabling recurring schedules.
  3. Save tracker (defaults to weekly cadence without running an immediate check; AI project IDs must be valid UUIDs):
     ```ts
     await client.callTool({
       name: "save_ai_visibility_tracker",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         engines: ["chatgpt", "perplexity"],
         prompts: [{ text: "kontraktor kaca terbaik surabaya" }]
       }
     });
     ```
  4. Configure and enable recurrence schedule (triggers an immediate initial baseline check upon enabling, nested under `data.run`; subsequent updates leave `data.run` nullable):
     ```ts
     const schedRes = await client.callTool({
       name: "set_ai_visibility_schedule",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         enabled: true,
         scheduleInterval: "weekly",
         scheduleTime: { weekday: 1, hour: 9, minute: 0, timeZone: "Asia/Jakarta" }
       }
     });
     // Inspect initial baseline run from schedule activation (nested under data.run)
     const baselineRun = schedRes.structuredContent?.data?.run;
     if (baselineRun?.id) {
       await client.callTool({
         name: "get_ai_visibility_run",
         arguments: {
           projectId: "00000000-0000-0000-0000-000000000001",
           runId: baselineRun.id
         }
       });
     }
     ```
  5. (Optional Live Run): If operator explicitly requests a separate immediate on-demand run:
     ```ts
     await client.callTool({
       name: "run_ai_visibility_check",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         maxCostUsd: runNowUsd
       }
     });
     ```

### Playbook 6C: Google Search Console Performance (`/search-performance`)
- **UI Route**: `/p/:projectId/settings/integrations` $\rightarrow$ `/p/:projectId/search-performance`
- **MCP Tools**: `get_search_console_performance`, `inspect_urls`
- **Prerequisite**: Google OAuth connected in project settings with GSC property bound (`sc-domain:kaca.co.id`).
- **Workflow**:
  1. Query metrics: `get_search_console_performance({ projectId: "00000000-0000-0000-0000-000000000001", startDate: "2026-10-01", endDate: "2026-11-20", dimensions: ["query", "page"] })`.
  2. Inspect index status: `inspect_urls({ projectId: "00000000-0000-0000-0000-000000000001", urls: ["https://kaca.co.id/produk/"] })`.

### Playbook 6D: Google Analytics 4 Organic Overview (`/ga4-overview`)
- **UI Route**: `/p/:projectId/settings/integrations#google-analytics`
- **MCP Tools**: `get_google_analytics_organic_overview`
- **Prerequisite**: GA4 property ID bound (`properties/<id>`).
- **Workflow**:
  1. Fetch organic acquisition and engagement: `get_google_analytics_organic_overview({ projectId: "00000000-0000-0000-0000-000000000001", startDate: "2026-10-01", endDate: "2026-11-20" })`.

### Playbook 6E: Backlinks & Domain Intelligence (`/domain`, `/backlinks`)
- **UI Route**: `/p/:projectId/domain` and `/p/:projectId/backlinks`
- **MCP Tools**: `get_backlinks_overview`, `get_backlinks_profile`
- **Workflow**:
  1. Overview: `get_backlinks_overview({ projectId: "00000000-0000-0000-0000-000000000001", target: "kaca.co.id" })`.
  2. Detailed referring domains and anchors: `get_backlinks_profile({ projectId: "00000000-0000-0000-0000-000000000001", target: "kaca.co.id", pageSize: 50, page: 1 })`.

### Playbook 6F: Executive SEO Reports & Sharing (`/reports`)
- **UI Route**: `/p/:projectId/reports`
- **MCP Tools**: `list_report_templates`, `list_reports`, `save_report`, `get_report`, `set_report_sharing`
- **Workflow**:
  1. List available report templates: `list_report_templates({})`.
  2. List existing reports: `list_reports({ projectId: "00000000-0000-0000-0000-000000000001" })`.
  3. Save complete audit report: `save_report({ projectId: "00000000-0000-0000-0000-000000000001", title: "Q4 2026 Technical Audit", summary: "Executive technical audit summary for Q4", html: "<!DOCTYPE html><html><head><title>Q4 Audit</title></head><body><h1>Audit Report</h1></body></html>" })`.
  4. Read back report: `get_report({ projectId: "00000000-0000-0000-0000-000000000001", reportId: "00000000-0000-0000-0000-000000000002" })`.
  5. (Hosted Only) Operator-Authorized Public Sharing:
     Explicit operator confirmation is required prior to public disclosure:
     ```ts
     // Enable public sharing
     await client.callTool({ name: "set_report_sharing", arguments: { projectId: "00000000-0000-0000-0000-000000000001", reportId: "00000000-0000-0000-0000-000000000002", public: true } });
     // Revoke public sharing
     await client.callTool({ name: "set_report_sharing", arguments: { projectId: "00000000-0000-0000-0000-000000000001", reportId: "00000000-0000-0000-0000-000000000002", public: false } });
     ```

### Playbook 6G: Project Setup & Brand Onboarding (`/projects`, `/settings`)
- **UI Route**: `/projects` (project creation) or `/p/:projectId/settings` (configuration)
- **MCP Tools**: `whoami`, `create_project`, `research_project_website`, `save_project_website_setup`, `get_project_context`
- **Workflow**:
  1. Verify caller identity, mode, and credits:
     ```ts
     const user = await client.callTool({ name: "whoami", arguments: {} });
     console.log(
       "Authenticated as:", user.structuredContent?.userEmail,
       "scopes:", user.structuredContent?.scopes,
       "mode:", user.structuredContent?.mode,
       "creditsRemaining:", user.structuredContent?.creditsRemaining
     );
     ```
  2. Create tracked domain project:
     ```ts
     const projRes = await client.callTool({
       name: "create_project",
       arguments: { domain: "toiletcubicle.co.id", name: "Toilet Cubicle Surabaya", languageCode: "id", locationCode: 2360 }
     });
     const projectId = projRes.structuredContent?.project?.id;
     if (!projectId) throw new Error("Project creation did not return an ID");
     ```
  3. Extract initial brand profile and save reviewed setup (passing required `name`, `domain`, `overview`, `competitors` and optional `suggestedTopics`, `suggestedKeywords`):
     ```ts
     await client.callTool({ name: "research_project_website", arguments: { projectId, website: "https://toiletcubicle.co.id" } });
     await client.callTool({
       name: "save_project_website_setup",
       arguments: {
         projectId,
         name: "Toilet Cubicle Surabaya",
         domain: "toiletcubicle.co.id",
         overview: "Surabaya commercial toilet cubicle contractor providing phenolic and glass cubicle installations.",
         competitors: [
           { name: "Cubicle ID", domain: "cubicle.id", notes: "Local competitor" }
         ],
         suggestedTopics: [
           {
             name: "Cubicle Toilet Surabaya",
             prompts: [
               "kontraktor cubicle toilet surabaya",
               "harga partisi toilet surabaya",
               "pasang cubicle phenolic surabaya",
               "distributor toilet cubicle surabaya",
               "spesialis partisi cubicle surabaya"
             ]
           }
         ],
         suggestedKeywords: ["cubicle toilet surabaya", "partisi toilet surabaya"]
       }
     });
     const context = await client.callTool({ name: "get_project_context", arguments: { projectId } });
     ```

### Playbook 6H: Keyword & SERP Research Workflows (`/keywords`)
- **UI Route**: `/p/:projectId/keywords` and `/p/:projectId/keywords/research`
- **MCP Tools**: `research_keywords`, `get_keyword_metrics`, `get_serp_results`, `save_keywords`, `get_ranked_keywords`
- **Workflow**:
  1. Research candidate keywords by seed array (1–5 seeds, allowed resultLimit: 150, 300, 500):
     ```ts
     const res = await client.callTool({
       name: "research_keywords",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         seeds: [{ seed: "cubicle toilet surabaya", locationCode: 2360, languageCode: "id" }],
         resultLimit: 150
       }
     });
     ```
  2. Inspect live SERP competitors and rankings (requires `projectId` and `queries` array):
     ```ts
     const serp = await client.callTool({
       name: "get_serp_results",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         queries: [{ keyword: "cubicle toilet surabaya", locationCode: 2360, languageCode: "id" }]
       }
     });
     ```
  3. Save high-intent keywords to project tracking:
     ```ts
     await client.callTool({
       name: "save_keywords",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         keywords: ["cubicle toilet surabaya", "partisi toilet phenolic"]
       }
     });
     ```

### Playbook 6I: Local SEO & Geo-Grid Visibility (`/keywords`, `/domain`)
- **UI Route**: Headless MCP capability (integrated with `/p/:projectId/keywords` and `/p/:projectId/domain`)
- **MCP Tools**: `search_local_businesses`, `get_local_rank_grid`
- **Workflow**:
  1. Search and bind target Google Business Profile (requires `projectId` and `near` coordinates/radius):
     ```ts
     const businesses = await client.callTool({
       name: "search_local_businesses",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         query: "Toilet Cubicle Surabaya",
         near: { latitude: -7.2575, longitude: 112.7521, radiusKm: 10 }
       }
     });
     ```
  2. Dispatch local geo-grid search around target coordinates:
     ```ts
     const grid = await client.callTool({
       name: "get_local_rank_grid",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         keyword: "partisi toilet",
         target: { name: "Toilet Cubicle Surabaya" },
         center: { latitude: -7.2575, longitude: 112.7521 },
         gridSize: 3,
         spacingKm: 2
       }
     });
     ```

### Playbook 6J: Audit Follow-Through & Granular Issue Inspection (`/audit`)
- **UI Route**: `/p/:projectId/audit?auditId=:auditId`
- **MCP Tools**: `get_audit_status`, `get_audit_issues`, `get_audit_pages`
- **Workflow**:
  1. Inspect running or completed crawl progress (status object wrapped in structuredContent.status):
     ```ts
     const statusRes = await client.callTool({
       name: "get_audit_status",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         auditId: "00000000-0000-0000-0000-000000000003"
       }
     });
     const status = statusRes.structuredContent?.status;
     console.log(`Audit phase: ${status?.currentPhase}, crawled: ${status?.pagesCrawled}`);
     ```
  2. Query issues filtered by severity:
     ```ts
     const issues = await client.callTool({
       name: "get_audit_issues",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         auditId: "00000000-0000-0000-0000-000000000003",
         severity: "critical",
         limit: 50
       }
     });
     ```
  3. Query crawled pages:
     ```ts
     const pages = await client.callTool({
       name: "get_audit_pages",
       arguments: {
         projectId: "00000000-0000-0000-0000-000000000001",
         auditId: "00000000-0000-0000-0000-000000000003",
         limit: 50
       }
     });
     ```

---

## 6. Complete 78-Tool Registry Reference by Capability Family

OpenSEO exposes 78 registered MCP tools in `src/server/mcp/server.ts`:

### Family 1: Workspace and Project Management (8 tools)
- `whoami`: Read authenticated identity, user email, and active organization ID.
- `create_project`: Create a new tracked domain project with language and location configuration.
- `list_projects`: List all active projects in the caller's organization.
- `research_project_website`: Crawl and summarize initial project brand data from root page.
- `save_project_website_setup`: Save initial domain branding and keyword focus during onboarding.
- `get_project_context`: Retrieve project configuration, target keywords, and brand identity.
- `update_project_context`: Update project branding, competitors, or target locale.
- `get_domain_overview`: Get aggregate domain metrics and health status.

### Family 2: Keyword, Domain and SERP Research (10 tools)
- `list_saved_keywords`: List enrolled keywords for a project with historical positions.
- `remove_saved_keywords`: Remove keywords from project tracking.
- `research_keywords`: Discover new keyword opportunities with search volume and CPC metrics.
- `save_keywords`: Save discovered keywords to project tracking.
- `get_domain_keyword_suggestions`: Generate keyword suggestions based on seed domain content.
- `get_serp_results`: Query live search engine result pages for target keyword and location.
- `search_serp_locations`: Search supported geographic location codes.
- `get_ranked_keywords`: Query keywords a target domain already ranks for.
- `find_serp_competitors`: Identify organic search competitors from shared SERP rankings.
- `get_keyword_metrics`: Retrieve detailed search volume, difficulty, and intent for keywords.

### Family 3: AI Visibility and Prompts (15 tools)
- `get_ai_visibility_tracker`: Retrieve configured AI visibility tracker configuration.
- `save_ai_visibility_tracker`: Save configured AI visibility engines and query prompts.
- `estimate_ai_visibility_cost`: Estimate API credit cost for AI visibility checks before dispatch.
- `run_ai_visibility_check`: Dispatch one-off or scheduled AI visibility collection run.
- `get_ai_visibility_run`: Inspect status, results, and citations of a specific AI visibility run.
- `explore_prompt`: Explore generative AI responses for a prompt query.
- `generate_ai_visibility_prompts`: Generate candidate visibility prompts for brand tracking.
- `research_ai_visibility_prompts`: Deep research on market prompts and citation opportunities.
- `complete_ai_research_setup`: Finalize AI visibility tracker setup with approved prompt set.
- `set_ai_visibility_schedule`: Configure recurring cron schedule for AI search monitoring.
- `get_ai_visibility_results`: Retrieve aggregated citations, sentiment, and share of voice.
- `get_ai_visibility_answer`: Inspect raw answer text from ChatGPT, Perplexity, or Gemini.
- `get_ai_visibility_sources`: List cited domains and URLs from generative AI answers.
- `get_ai_visibility_trend`: Retrieve historical citation share trends over time.
- `export_ai_visibility_data`: Export visibility results to structured JSON/CSV format.

### Family 4: Rank Tracking Maintenance (7 tools)
- `create_rank_tracker`: Initialize rank tracking for a project domain.
- `add_rank_tracking_keywords`: Add keyword queries to active rank tracker.
- `estimate_rank_tracker_cost`: Calculate DataForSEO credit cost before executing tracking run.
- `run_rank_tracker`: Execute rank tracking check across search engines.
- `get_rank_tracker`: Retrieve current positions, SERP features, and ranking distribution.
- `remove_rank_tracking_keywords`: Delete tracked keywords.
- `pin_rank_tracking_keywords`: Pin high-priority keywords for quick dashboard access.

### Family 5: Local SEO & Google Business Profile (8 tools)
- `search_local_businesses`: Search Google Maps businesses by query and coordinates.
- `get_local_serp_results`: Query local pack search results.
- `get_google_business_questions`: Retrieve Q&A questions from Google Business Profile.
- `get_business_profile`: Retrieve complete GBP metadata, hours, and attributes.
- `get_business_reviews`: Retrieve customer reviews and star ratings.
- `get_business_updates`: Retrieve posts and updates from Google Business Profile.
- `list_business_categories`: Search valid Google Business categories.
- `get_local_rank_grid`: Generate geo-grid rank distribution across geographic coordinates.

### Family 6: GA4, Search Console & Search Opportunities (12 tools)
- `get_google_analytics_organic_overview`: High-level organic traffic and engagement metrics.
- `get_google_analytics_organic_landing_pages`: Landing page traffic acquisition performance.
- `get_google_analytics_page_performance`: Page-level metrics, bounce rates, and session durations.
- `get_google_analytics_key_events`: Conversion events and ecommerce goals attributed to search.
- `get_search_opportunities`: Cross-reference GSC impressions with GA4 conversions to identify quick wins.
- `get_google_analytics_traffic_acquisition`: Session channel breakdown (organic, direct, referral).
- `get_google_analytics_measurement_health`: Validate GA4 measurement tag health and event streaming.
- `get_google_analytics_ecommerce_performance`: Revenue, transactions, and average order value.
- `get_google_analytics_site_search`: Internal search queries entered by visitors.
- `get_google_analytics_audience_breakdown`: Visitor demographics, devices, and browsers.
- `get_search_console_performance`: Query Google Search Console performance data (clicks, impressions, CTR, position).
- `inspect_urls`: Inspect indexation status and canonical URL indexing via Search Console API.

### Family 7: Audit Follow-Through & Fleet (8 tools)
- `run_site_audit`: Trigger live edge HTTP site crawl on auxiliary worker.
- `list_site_audits`: List historical crawl runs for a project.
- `delete_site_audit`: Delete a historical crawl run and associated pages/issues.
- `get_audit_status`: Query active crawl phase, progress percentage, and page counts.
- `get_audit_issues`: Query detected issues for an audit with severity filtering.
- `get_audit_pages`: Retrieve crawled URL records and page-level metadata.
- `get_fleet_issues`: Query aggregated technical SEO issues across the entire enrolled fleet.
- `run_fleet_audit`: Generate execution plan for fleet-wide audits across enrolled properties.

### Family 8: Reports, Templates & Backlinks (10 tools)
- `list_report_templates`: List available executive report templates.
- `save_report_template`: Save a custom reusable report layout.
- `delete_report_template`: Delete a report template.
- `list_reports`: List generated reports for a project.
- `save_report`: Save a complete HTML executive report document.
- `get_report`: Retrieve report HTML and executive summary.
- `delete_report`: Delete a saved report.
- `set_report_sharing`: Toggle public sharing link for a report.
- `get_backlinks_overview`: Domain backlink authority score, referring domains, and total links.
- `get_backlinks_profile`: Paginated list of referring domains, anchors, and anchor texts.

---

## 7. Safety Boundaries & Prohibitions

1. ❌ **No unconstrained fleet updates**: Never run raw global SQL updates across `fleet_roster_members`. Use version- and organization-scoped predicates or `import-fleet-roster.ts`.
2. ❌ **Explicit Execution Scope**: Never launch unbounded workspace-wide audits without an explicit `--domain <host>`, `--all`, or `--limit <n>` flag.
3. ❌ **Distinguish `complete` from `partial`**: Never report an audit as `completed` if child batch writes failed or were not verified. Reconcile persisted children in the final compare-and-set UPDATE.
4. ❌ **Strict Exact Domain Targeting**: Always match exact domain in CLI audit runners (`c.domain === targetDomain`). Never fall back to substring matching.
5. ❌ **Atomic Staged Persistence**: Never commit a completed audit before all child page and issue chunks are verified and reconciled.
6. ❌ **Keep secrets strictly in AgentSecrets**: Cloudflare Access tokens, DataForSEO keys, and D1 credentials must never be exposed in plaintext logs or chat.
7. ❌ **Maintain 0 auxiliary worktrees on disk**: Prune worktrees immediately after use to protect disk headroom on the host workstation.
