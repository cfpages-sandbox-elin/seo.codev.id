/**
 * Headless Fleet Audit Runner for OpenSEO on seo.codev.id.
 *
 * Dispatches full-depth site audits (maxPages: 2000, zero page omission)
 * across enrolled projects in Cloudflare D1 with rolling concurrency pacing.
 *
 * Usage:
 *   pnpm exec tsx scripts/run-fleet-audits.ts [--limit <n>] [--concurrency <n>] [--domain <domain>] [--max-pages <n>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import {
  buildSqliteEffectiveRosterSql,
  executeD1SqlBatches,
  isValidCanonicalHostname,
  selectEffectiveRosterVersion,
  sqlText,
} from "./github-archive-utils";

// Sourced environment from .env.selfhost (repo-relative)
const ENV_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env.selfhost",
);

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  try {
    const content = readFileSync(ENV_FILE, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0 && !line.startsWith("#")) {
        const key = line.slice(0, eqIdx).trim();
        const val = line
          .slice(eqIdx + 1)
          .trim()
          .replace(/^['"]|['"]$/g, "");
        if (val) {
          env[key] = val;
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.warn("Could not read .env.selfhost:", err);
  }
  return env;
}

const envVars = loadEnv();

function runD1Query(query: string, isRemote = true): any[] {
  return executeD1SqlBatches([query], isRemote);
}

type DispatchOutcome = "accepted" | "definitively_rejected" | "unknown";

function triggerWorkflow(
  workflowName: string,
  id: string,
  params: object,
  isRemote = true,
): { outcome: DispatchOutcome; message?: string } {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const wranglerJs = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");
  const paramsStr = JSON.stringify(params);
  const argv = [
    wranglerJs,
    "workflows",
    "trigger",
    workflowName,
    paramsStr,
    "--id",
    id,
  ];
  if (!isRemote) argv.push("--local");

  const res = spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    env: { ...process.env, ...envVars },
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
  });

  if (res.status === 0) {
    return { outcome: "accepted" };
  }

  const output = ((res.stderr || "") + " " + (res.stdout || "")).toLowerCase();
  const isConfirmedPreRejection =
    !res.error &&
    res.signal === null &&
    (output.includes("unknown workflow") ||
      output.includes("workflow not found") ||
      output.includes("invalid workflow") ||
      output.includes("invalid params") ||
      output.includes("missing required") ||
      output.includes("validation error"));

  if (isConfirmedPreRejection) {
    console.error(
      `[DISPATCH REJECTED] Confirmed rejection for workflow instance ${id}: ${res.stderr || res.stdout}`,
    );
    return {
      outcome: "definitively_rejected",
      message: res.stderr || res.stdout,
    };
  }

  console.warn(
    `[DISPATCH UNCERTAIN] Wrangler trigger for instance ${id} returned ambiguous failure or timed out (status=${res.status}, signal=${res.signal}): ${res.error?.message || output}. Retaining running status and monitoring for resolution.`,
  );
  return {
    outcome: "unknown",
    message:
      res.error?.message ||
      res.stderr ||
      res.stdout ||
      "Trigger response timed out or ambiguous",
  };
}

interface TargetProject {
  id: string;
  name: string;
  domain: string;
  lastAuditedEpoch?: number | null;
}

async function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        limit: { type: "string", short: "l" },
        concurrency: { type: "string", short: "c", default: "2" },
        domain: { type: "string", short: "d" },
        "roster-id": { type: "string" },
        "expected-member": { type: "string" },
        "expected-project": { type: "string" },
        "max-pages": { type: "string", short: "m", default: "500" },
        "skip-recent": { type: "boolean", default: true },
        "no-skip-recent": { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        remote: { type: "boolean" },
        local: { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err: any) {
    console.error(`[ERROR] Invalid arguments: ${err.message}`);
    process.exit(1);
  }

  if (args.values.remote && args.values.local) {
    console.error(
      "[ERROR] Conflicting flags: cannot specify both --remote and --local.",
    );
    process.exit(1);
  }

  let maxPages = 500;
  if (args.values["max-pages"] !== undefined) {
    const raw = String(args.values["max-pages"]);
    const num = Number(raw);
    if (
      !/^[1-9][0-9]*$/.test(raw) ||
      !Number.isSafeInteger(num) ||
      num < 1 ||
      num > 10000
    ) {
      console.error(
        "[ERROR] Invalid --max-pages value. Must be a safe positive integer between 1 and 10000.",
      );
      process.exit(1);
    }
    maxPages = num;
  }

  const rawConcurrency =
    args.values.concurrency !== undefined
      ? String(args.values.concurrency)
      : "2";
  const numConcurrency = Number(rawConcurrency);
  if (
    !/^[1-5]$/.test(rawConcurrency) ||
    !Number.isSafeInteger(numConcurrency)
  ) {
    console.error(
      "[ERROR] Invalid --concurrency value. Must be a safe integer between 1 and 5.",
    );
    process.exit(1);
  }
  const concurrency = numConcurrency;
  let limit: number | undefined;
  if (args.values.limit !== undefined) {
    const raw = String(args.values.limit);
    const num = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(num)) {
      console.error(
        "[ERROR] Invalid --limit value. Must be a safe positive integer.",
      );
      process.exit(1);
    }
    limit = num;
  }
  const targetDomainFilter =
    args.values.domain !== undefined
      ? String(args.values.domain).toLowerCase().trim()
      : undefined;
  if (
    targetDomainFilter !== undefined &&
    !isValidCanonicalHostname(targetDomainFilter)
  ) {
    console.error(
      `[ERROR] Invalid fleet hostname: "${args.values.domain}". Must be a valid lowercase RFC 1123 hostname without protocol, port, or path.`,
    );
    process.exit(1);
  }

  const isAll = !!args.values.all;
  const isRemote = args.values.local ? false : true;
  const target = isRemote
    ? {
        database: "open-seo-db-selfhost",
        dbFlag: "--remote",
        workflow: "site-audit-workflow-selfhost",
      }
    : { database: "DB", dbFlag: "--local", workflow: "site-audit-workflow" };

  // Sol P2-04: Require mutually exclusive explicit execution scope
  const scopeCount =
    Number(args.values.domain !== undefined) +
    Number(args.values.all === true) +
    Number(args.values.limit !== undefined);
  if (scopeCount !== 1) {
    console.error(
      "[ERROR] Missing or conflicting execution scope. Please specify exactly one of --domain <canonical-host>, --all, or --limit <n>.",
    );
    process.exit(1);
  }

  const rawExpectedMember = args.values["expected-member"];
  const rawExpectedProject = args.values["expected-project"];
  if (rawExpectedMember !== undefined && rawExpectedMember.trim() === "") {
    console.error("[ERROR] --expected-member cannot be empty.");
    process.exit(1);
  }
  if (rawExpectedProject !== undefined && rawExpectedProject.trim() === "") {
    console.error("[ERROR] --expected-project cannot be empty.");
    process.exit(1);
  }
  const expectedMember = rawExpectedMember?.trim();
  const expectedProject = rawExpectedProject?.trim();

  if (!targetDomainFilter && (expectedMember || expectedProject)) {
    console.error(
      "[ERROR] --expected-member and --expected-project are strictly single-target options and cannot be combined with bulk execution.",
    );
    process.exit(1);
  }

  const rawRosterId = args.values["roster-id"];
  const rosterId = rawRosterId ? String(rawRosterId).trim() : null;
  if (rawRosterId !== undefined && !rosterId) {
    console.error("[ERROR] --roster-id cannot be empty.");
    process.exit(1);
  }
  if ((expectedMember || expectedProject) && !rosterId) {
    console.error(
      "[ERROR] --expected-member and --expected-project require --roster-id to bind the complete admission tuple.",
    );
    process.exit(1);
  }

  console.log("=== OpenSEO Fleet Audit Runner ===");
  console.log(
    `Execution Mode: ${isRemote ? "Remote Production" : "Local Development"}`,
  );
  console.log(`Target Workflow: ${target.workflow}`);
  console.log(`Pacing Concurrency: ${concurrency}`);
  console.log(`Max Pages Per Site: ${maxPages} (Full Depth Crawl)`);
  if (targetDomainFilter)
    console.log(`Target Domain Filter: ${targetDomainFilter}`);

  // Sol Round 21 F01: Assert effective approved roster on execution DB
  const allRosterVersions = runD1Query(
    "SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = 'shared-workspace';",
    isRemote,
  );
  const effectiveRoster = selectEffectiveRosterVersion(allRosterVersions);

  if (rosterId) {
    if (!effectiveRoster || effectiveRoster.id !== rosterId) {
      console.error(
        `[ERROR] Planned roster '${rosterId}' is no longer effective on the execution DB (effective is '${effectiveRoster?.id ?? "none"}').`,
      );
      process.exit(1);
    }
    console.log(
      `Enrolled Roster Filter: ${rosterId} (verified effective approved version)`,
    );
  }

  // Sol R31 V3-02: Census active roster members BEFORE inner-joining projects so unlinked/archived/stale members cannot be silently dropped.
  let unmappedRosterCount = 0;
  if (rosterId) {
    const rosterCensusRows = runD1Query(
      `SELECT rm.id AS member_id, rm.canonical_host, rm.project_id,
              p.id AS active_project_id
       FROM fleet_roster_members rm
       JOIN fleet_roster_versions rv ON rv.id = rm.version_id
       LEFT JOIN projects p ON p.id = rm.project_id
         AND p.organization_id = rv.organization_id
         AND p.archived_at IS NULL
         AND lower(trim(p.domain)) = lower(trim(rm.canonical_host))
       WHERE rm.version_id = ${sqlText(rosterId)}
         AND rv.organization_id = 'shared-workspace'
         AND rv.id = ${buildSqliteEffectiveRosterSql("'shared-workspace'")}
         AND rm.enrollment_state = 'active';`,
      isRemote,
    );
    const brokenMembers = rosterCensusRows.filter((r) => !r.active_project_id);
    unmappedRosterCount = brokenMembers.length;
    if (unmappedRosterCount > 0) {
      console.warn(
        `[WARNING] Effective roster '${rosterId}' has ${unmappedRosterCount} unlinked/archived/stale active member(s): ${brokenMembers
          .slice(0, 5)
          .map((r) => `${r.canonical_host}(${r.member_id})`)
          .join(", ")}.`,
      );
    }
  }

  // Query enrolled projects in shared-workspace with normalized UTC epoch of completed edge crawls (Sol F05, C2)
  const sql = `
    SELECT p.id, p.name, p.domain, MAX(unixepoch(a.completed_at)) AS last_audited_epoch
    FROM projects p
    ${
      rosterId
        ? `JOIN fleet_roster_members rm ON rm.project_id = p.id AND rm.version_id = ${sqlText(rosterId)} AND rm.enrollment_state = 'active' AND lower(trim(rm.canonical_host)) = lower(trim(p.domain))
           JOIN fleet_roster_versions rv ON rv.id = rm.version_id AND rv.organization_id = p.organization_id AND rv.approved_at IS NOT NULL`
        : ""
    }
    LEFT JOIN audits a ON p.id = a.project_id
      AND a.status = 'completed'
      AND (a.workflow_instance_id NOT LIKE 'github-audit-%' OR a.workflow_instance_id IS NULL)
    WHERE p.organization_id = 'shared-workspace'
      AND p.domain IS NOT NULL
      AND p.archived_at IS NULL
    GROUP BY p.id, p.name, p.domain
    ORDER BY last_audited_epoch ASC NULLS FIRST, p.created_at ASC;
  `;

  const rows = runD1Query(sql, isRemote);
  console.log(`Retrieved ${rows.length} total enrolled projects from D1.`);

  let candidates: TargetProject[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    lastAuditedEpoch:
      typeof r.last_audited_epoch === "number" ? r.last_audited_epoch : null,
  }));

  let ambiguousExcludedCount = 0;
  let recentSkippedCount = 0;

  if (targetDomainFilter) {
    candidates = candidates.filter(
      (c) => c.domain.trim().toLowerCase() === targetDomainFilter,
    );
    if (candidates.length === 0) {
      console.error(
        `[ERROR] Target domain '${targetDomainFilter}' was not found among enrolled projects in shared-workspace.`,
      );
      process.exit(1);
    }
    if (candidates.length > 1) {
      console.error(
        `[ERROR] Ambiguous domain binding: multiple active projects (${candidates.length}) found for '${targetDomainFilter}'.`,
      );
      process.exit(1);
    }
    // Sol R24-08, V1-01: Assert complete bound single-target plan tuple (project, member, roster, canonical host)
    if (expectedProject && candidates[0].id !== expectedProject) {
      console.error(
        `[ERROR] TARGET_BINDING_MISMATCH: Planned project ID '${expectedProject}' does not match live project ID '${candidates[0].id}' for domain '${targetDomainFilter}'.`,
      );
      process.exit(1);
    }
    if (expectedMember && rosterId) {
      const memberRows = runD1Query(
        `SELECT id FROM fleet_roster_members WHERE id = ${sqlText(expectedMember)} AND version_id = ${sqlText(rosterId)} AND project_id = ${sqlText(candidates[0].id)} AND enrollment_state = 'active' AND lower(trim(canonical_host)) = ${sqlText(targetDomainFilter)};`,
        isRemote,
      );
      if (!memberRows || memberRows.length === 0) {
        console.error(
          `[ERROR] TARGET_BINDING_MISMATCH: Planned member ID '${expectedMember}' is not an active member for project '${candidates[0].id}' (host '${targetDomainFilter}') in roster '${rosterId}'.`,
        );
        process.exit(1);
      }
    }
  } else {
    // Detect and reject ambiguous duplicate domain bindings across the enrolled fleet
    const seenDomains = new Set<string>();
    const ambiguousDomains = new Set<string>();
    for (const c of candidates) {
      const d = c.domain.toLowerCase();
      if (seenDomains.has(d)) ambiguousDomains.add(d);
      seenDomains.add(d);
    }
    if (ambiguousDomains.size > 0) {
      ambiguousExcludedCount = candidates.filter((c) =>
        ambiguousDomains.has(c.domain.toLowerCase()),
      ).length;
      console.warn(
        `[WARNING] Excluding ${ambiguousDomains.size} ambiguous domain(s) (${ambiguousExcludedCount} project row(s)) with duplicate bindings: ${Array.from(ambiguousDomains).join(", ")}`,
      );
      candidates = candidates.filter(
        (c) => !ambiguousDomains.has(c.domain.toLowerCase()),
      );
    }
  }

  const eligiblePreRecencyCount = candidates.length;

  const shouldSkipRecent = args.values["no-skip-recent"]
    ? false
    : !!args.values["skip-recent"];
  if (shouldSkipRecent && !targetDomainFilter) {
    const tenDaysAgoEpoch = Math.floor(
      (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000,
    );
    const beforeFilter = candidates.length;
    candidates = candidates.filter(
      (c) =>
        c.lastAuditedEpoch === null ||
        c.lastAuditedEpoch === undefined ||
        c.lastAuditedEpoch < tenDaysAgoEpoch,
    );
    recentSkippedCount = beforeFilter - candidates.length;
  }

  if (limit) {
    candidates = candidates.slice(0, limit);
  }

  console.log(`Queue populated with ${candidates.length} candidate projects.`);

  // Process queue with concurrency window
  const activeAudits = new Map<
    string,
    {
      auditId: string;
      project: TargetProject;
      startedAt: number;
      isAmbiguous?: boolean;
    }
  >();
  let queueIndex = 0;
  let triggeredCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let skippedBusyCount = 0;
  let bindingConflictCount = 0;
  let admissionPaused = false;

  async function pollActiveAudits() {
    for (const [auditId, info] of Array.from(activeAudits.entries())) {
      let statusRows: any[] = [];
      try {
        statusRows = runD1Query(
          `SELECT status, pages_crawled, current_phase, error_code FROM audits WHERE id = ${sqlText(auditId)};`,
          isRemote,
        );
      } catch (err: any) {
        console.warn(
          `[POLL RETRY] Transient D1 read error for ${auditId} (${info.project.domain}): ${err?.message || err}. Retaining active slot for next cycle.`,
        );
        continue;
      }
      if (statusRows.length === 0) {
        console.warn(
          `[WARNING] Audit ${auditId} for ${info.project.domain} not found in database.`,
        );
        activeAudits.delete(auditId);
        failedCount++;
        continue;
      }

      const audit = statusRows[0];
      const isTerminal =
        audit.status === "completed" || audit.status === "failed";

      if (!isTerminal && Date.now() - info.startedAt > 15 * 60 * 1000) {
        // Sol F6: At deadline, pause admission to avoid exceeding concurrency window while workflow still runs
        if (!admissionPaused) {
          admissionPaused = true;
          console.warn(
            `[DEADLINE EXCEEDED] Audit ${auditId} for ${info.project.domain} still running after 15m. Admission paused to protect concurrency cap.`,
          );
        }
      }

      if (audit.status === "completed") {
        console.log(
          `[COMPLETED] ${info.project.domain} (Pages crawled: ${audit.pages_crawled})`,
        );
        activeAudits.delete(auditId);
        completedCount++;
      } else if (audit.status === "failed") {
        console.log(
          `[FAILED] ${info.project.domain} (Phase: ${audit.current_phase}, Error: ${audit.error_code || "UNKNOWN"})`,
        );
        activeAudits.delete(auditId);
        failedCount++;
      } else {
        // Still running
        console.log(
          `[RUNNING] ${info.project.domain} - Phase: ${audit.current_phase || "crawling"}, Pages: ${audit.pages_crawled || 0}`,
        );
      }
    }
  }

  const DRAIN_MS = 5 * 60 * 1000;

  while (queueIndex < candidates.length || activeAudits.size > 0) {
    await pollActiveAudits();
    const now = Date.now();
    const overdue = Array.from(activeAudits.values()).filter(
      (item) => now - item.startedAt > 15 * 60 * 1000,
    );

    // If an overdue item exceeds 15m + DRAIN_MS (20m total), break loop to prevent indefinite polling
    if (
      overdue.some((item) => now - item.startedAt > 15 * 60 * 1000 + DRAIN_MS)
    ) {
      const unresolvedIds = Array.from(activeAudits.keys());
      console.error(
        `[DRAIN TIMEOUT] Active audit exceeded 20m deadline. Unresolved in-flight audit IDs: ${unresolvedIds.join(", ")}. Terminating queue drain.`,
      );
      break;
    }

    // Only dispatch new work if no overdue audits are in flight (Sol F05)
    if (overdue.length === 0) {
      while (
        activeAudits.size < concurrency &&
        queueIndex < candidates.length
      ) {
        const project = candidates[queueIndex++];
        const cleanHost = project.domain.trim().toLowerCase();
        if (!isValidCanonicalHostname(cleanHost)) {
          console.error(
            `[ERROR] Stored domain '${project.domain}' for project ${project.id} is invalid. Skipping dispatch.`,
          );
          failedCount++;
          continue;
        }

        let parsedStartUrl: URL;
        try {
          parsedStartUrl = new URL(`https://${cleanHost}`);
          if (parsedStartUrl.hostname !== cleanHost) {
            throw new Error(
              `Hostname mismatch: expected '${cleanHost}', got '${parsedStartUrl.hostname}'`,
            );
          }
        } catch (e: any) {
          console.error(
            `[ERROR] Invalid start URL for project ${project.id} (${cleanHost}): ${e?.message}`,
          );
          failedCount++;
          continue;
        }

        const auditId = crypto.randomUUID();
        const startUrl = parsedStartUrl.toString();

        const config = {
          maxPages,
          lighthouseStrategy: "auto",
          renderJavaScript: false,
        };

        console.log(
          `[DISPATCH] Launching audit on ${project.domain} (${startUrl}) [ID: ${auditId}]`,
        );

        // 1. Insert audit row in D1 conditionally — prevents concurrent edge audits and asserts complete expected tuple (Sol V1-01, R1, R5)
        const insertSql = `
          INSERT INTO audits (
            id, project_id, started_by_user_id, start_url,
            workflow_instance_id, config, status, pages_crawled,
            pages_total, lighthouse_total, current_phase, started_at
          )
          SELECT
            ${sqlText(auditId)}, ${sqlText(project.id)}, 'system', ${sqlText(startUrl)},
            ${sqlText(auditId)}, ${sqlText(JSON.stringify(config))}, 'running', 0,
            ${maxPages}, 20, 'discovery', ${sqlText(new Date().toISOString())}
          WHERE NOT EXISTS (
            SELECT 1 FROM audits
            WHERE project_id = ${sqlText(project.id)} AND status = 'running'
          )
          AND EXISTS (
            SELECT 1 FROM projects
            WHERE id = ${sqlText(project.id)}
              AND archived_at IS NULL
              AND organization_id = 'shared-workspace'
              AND lower(trim(domain)) = ${sqlText(cleanHost)}
          )
          ${
            rosterId
              ? `AND EXISTS (
                   SELECT 1 FROM fleet_roster_members rm
                   JOIN fleet_roster_versions rv ON rv.id = rm.version_id
                   WHERE rm.project_id = ${sqlText(project.id)}
                     AND rm.version_id = ${sqlText(rosterId)}
                     AND rm.enrollment_state = 'active'
                     AND lower(trim(rm.canonical_host)) = ${sqlText(cleanHost)}
                     ${expectedMember ? `AND rm.id = ${sqlText(expectedMember)}` : ""}
                     AND rv.id = ${buildSqliteEffectiveRosterSql("'shared-workspace'")}
                 )`
              : ""
          }
          RETURNING id;
        `;
        const reserved = runD1Query(insertSql, isRemote);
        if (!reserved || reserved.length === 0) {
          const runningCheck = runD1Query(
            `SELECT id FROM audits WHERE project_id = ${sqlText(project.id)} AND status = 'running' LIMIT 1;`,
            isRemote,
          );
          if (runningCheck && runningCheck.length > 0) {
            console.warn(
              `[SKIP_BUSY] Project ${project.domain} (${project.id}) already has an active running audit (${runningCheck[0].id}). Skipping concurrent dispatch.`,
            );
            skippedBusyCount++;
          } else {
            console.error(
              `[BINDING_CONFLICT] Project ${project.domain} (${project.id}) admission tuple (member=${expectedMember ?? "any"}, roster=${rosterId ?? "none"}) was superseded or drifted before reservation.`,
            );
            bindingConflictCount++;
          }
          continue;
        }

        const reservationStartedAt = Date.now();

        // 2. Trigger workflow instance
        const params = {
          auditId,
          billingCustomer: {
            userId: "system",
            userEmail: "admin@alampintar.org",
            organizationId: "shared-workspace",
            projectId: project.id,
          },
          projectId: project.id,
          startUrl,
          config,
          access: null,
          renderLocks: [],
        };

        triggeredCount++;
        const dispatch = triggerWorkflow(
          target.workflow,
          auditId,
          params,
          isRemote,
        );
        if (dispatch.outcome === "accepted" || dispatch.outcome === "unknown") {
          activeAudits.set(auditId, {
            auditId,
            project,
            startedAt: reservationStartedAt,
            isAmbiguous: dispatch.outcome === "unknown",
          });
        } else {
          console.error(
            `[ERROR] Confirmed dispatch rejection for ${project.domain}: ${dispatch.message}`,
          );
          const failSql = `UPDATE audits SET status = 'failed', current_phase = 'failed', failed_phase = 'discovery', error_code = 'DISPATCH_ERROR', completed_at = ${sqlText(new Date().toISOString())} WHERE id = ${sqlText(auditId)} AND status = 'running' RETURNING id;`;
          const failedRows = runD1Query(failSql, isRemote);
          if (!failedRows || failedRows.length === 0) {
            console.warn(
              `[WARN] Dispatch error update for ${auditId} updated 0 rows (audit already terminal).`,
            );
          }
          failedCount++;
        }
      }
    } else {
      console.warn(
        `[ADMISSION PAUSED] ${overdue.length} audit(s) running past 15m. Waiting for slot drain before admitting new candidates.`,
      );
    }

    if (activeAudits.size > 0) {
      // Wait 10 seconds between polls
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  const undispatched = candidates.slice(queueIndex);
  console.log("\n=== Fleet Audit Run Finished ===");
  console.log(`Eligible Pre-Recency Candidates: ${eligiblePreRecencyCount}`);
  console.log(`Unmapped / Stale Active Roster Members: ${unmappedRosterCount}`);
  console.log(`Ambiguous Domain Exclusions: ${ambiguousExcludedCount}`);
  console.log(`Skipped (Recent Within 10d): ${recentSkippedCount}`);
  console.log(`Total Candidates Selected: ${candidates.length}`);
  console.log(`Workflow Dispatches Triggered: ${triggeredCount}`);
  console.log(`Total Completed: ${completedCount}`);
  console.log(`Total Failed: ${failedCount}`);
  console.log(`Skipped (Reservation Busy): ${skippedBusyCount}`);
  console.log(`Binding Conflicts: ${bindingConflictCount}`);
  console.log(`Active Remaining: ${activeAudits.size}`);
  console.log(`Undispatched Remaining: ${undispatched.length}`);
  const incomplete =
    failedCount +
    bindingConflictCount +
    activeAudits.size +
    undispatched.length +
    skippedBusyCount +
    ambiguousExcludedCount +
    (!targetDomainFilter ? unmappedRosterCount : 0);
  const emptyBulkPopulation =
    !targetDomainFilter && eligiblePreRecencyCount === 0;
  if (emptyBulkPopulation) {
    console.error(
      "[ERROR] Bulk fleet audit had 0 eligible candidates before recency filtering.",
    );
  }
  if (
    incomplete > 0 ||
    emptyBulkPopulation ||
    (targetDomainFilter && completedCount === 0)
  ) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal fleet audit runner error:", err);
  process.exit(1);
});
