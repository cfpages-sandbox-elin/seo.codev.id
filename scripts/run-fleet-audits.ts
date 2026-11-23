/**
 * Headless Fleet Audit Runner for OpenSEO on seo.codev.id.
 *
 * Dispatches full-depth site audits (maxPages: 2000, zero page omission)
 * across enrolled projects in Cloudflare D1 with rolling concurrency pacing.
 *
 * Usage:
 *   pnpm exec tsx scripts/run-fleet-audits.ts [--limit <n>] [--concurrency <n>] [--domain <domain>] [--max-pages <n>]
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { isValidCanonicalHostname } from "./github-archive-utils";

// Sourced environment from .env.selfhost
const ENV_FILE = resolve(
  "C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/.env.selfhost",
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
        const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
        env[key] = val;
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.warn("Could not read .env.selfhost:", err);
  }
  return env;
}

const envVars = loadEnv();

function extractJson(raw: string): any {
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1) {
    return JSON.parse(raw.slice(firstBracket, lastBracket + 1));
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(raw);
}

function runD1Query(query: string, isRemote = true): any[] {
  const sanitized = query.replace(/\r?\n/g, " ").trim();
  const flag = isRemote ? "--remote" : "--local";
  const dbName = isRemote ? "open-seo-db-selfhost" : "DB";
  const cmd = `npx wrangler d1 execute ${dbName} ${flag} --json --command "${sanitized.replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, {
    cwd: "C:/Users/THINKPAD/Documents/GitHub/seo.codev.id",
    env: { ...process.env, ...envVars },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const parsed = extractJson(out);
  if (Array.isArray(parsed) && parsed[0]?.results) {
    return parsed[0].results;
  }
  return [];
}

function triggerWorkflow(
  workflowName: string,
  id: string,
  params: object,
  isRemote = true,
): boolean {
  const paramsStr = JSON.stringify(params);
  const flag = isRemote ? "" : "--local";
  const cmd = `npx wrangler workflows trigger ${workflowName} "${paramsStr.replace(/"/g, '\\"')}" --id ${id} ${flag}`.trim();
  try {
    execSync(cmd, {
      cwd: "C:/Users/THINKPAD/Documents/GitHub/seo.codev.id",
      env: { ...process.env, ...envVars },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err: any) {
    console.error(
      `Failed to trigger workflow instance ${id}:`,
      err?.message || err,
    );
    return false;
  }
}

interface TargetProject {
  id: string;
  name: string;
  domain: string;
  lastAuditedEpoch?: number | null;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--remote") && rawArgs.includes("--local")) {
    console.error("[ERROR] Conflicting flags: cannot specify both --remote and --local.");
    process.exit(1);
  }

  const args = parseArgs({
    options: {
      limit: { type: "string", short: "l" },
      concurrency: { type: "string", short: "c", default: "2" },
      domain: { type: "string", short: "d" },
      "max-pages": { type: "string", short: "m", default: "500" },
      "skip-recent": { type: "boolean", default: true },
      "no-skip-recent": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (args.positionals.length > 0) {
    console.error(`[ERROR] Stray positional arguments detected (${args.positionals.join(", ")}). Positional arguments not permitted.`);
    process.exit(1);
  }

  let maxPages = 500;
  if (args.values["max-pages"] !== undefined) {
    const raw = String(args.values["max-pages"]);
    const num = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(num) || num < 1 || num > 10000) {
      console.error("[ERROR] Invalid --max-pages value. Must be a safe positive integer between 1 and 10000.");
      process.exit(1);
    }
    maxPages = num;
  }

  const rawConcurrency = args.values.concurrency !== undefined ? String(args.values.concurrency) : "2";
  const numConcurrency = Number(rawConcurrency);
  if (!/^[1-5]$/.test(rawConcurrency) || !Number.isSafeInteger(numConcurrency)) {
    console.error("[ERROR] Invalid --concurrency value. Must be a safe integer between 1 and 5.");
    process.exit(1);
  }
  const concurrency = numConcurrency;
  let limit: number | undefined;
  if (args.values.limit !== undefined) {
    const raw = String(args.values.limit);
    const num = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(num)) {
      console.error("[ERROR] Invalid --limit value. Must be a safe positive integer.");
      process.exit(1);
    }
    limit = num;
  }
  const targetDomainFilter = args.values.domain !== undefined ? String(args.values.domain).toLowerCase().trim() : undefined;
  if (targetDomainFilter !== undefined && !isValidCanonicalHostname(targetDomainFilter)) {
    console.error(`[ERROR] Invalid fleet hostname: "${args.values.domain}". Must be a valid lowercase RFC 1123 hostname without protocol, port, or path.`);
    process.exit(1);
  }

  const isAll = !!args.values.all;
  const isRemote = args.values.local ? false : true;
  const target = isRemote
    ? { database: "open-seo-db-selfhost", dbFlag: "--remote", workflow: "site-audit-workflow-selfhost" }
    : { database: "DB", dbFlag: "--local", workflow: "site-audit-workflow" };

  // Sol P2-04: Require mutually exclusive explicit execution scope
  const scopeCount =
    Number(args.values.domain !== undefined) +
    Number(args.values.all === true) +
    Number(args.values.limit !== undefined);
  if (scopeCount !== 1) {
    console.error("[ERROR] Missing or conflicting execution scope. Please specify exactly one of --domain <canonical-host>, --all, or --limit <n>.");
    process.exit(1);
  }

  console.log("=== OpenSEO Fleet Audit Runner ===");
  console.log(`Execution Mode: ${isRemote ? "Remote Production" : "Local Development"}`);
  console.log(`Target Workflow: ${target.workflow}`);
  console.log(`Pacing Concurrency: ${concurrency}`);
  console.log(`Max Pages Per Site: ${maxPages} (Full Depth Crawl)`);
  if (targetDomainFilter) console.log(`Target Domain Filter: ${targetDomainFilter}`);

  // Query enrolled projects in shared-workspace with normalized UTC epoch (Sol F4)
  const sql = `
    SELECT p.id, p.name, p.domain, MAX(unixepoch(a.started_at)) AS last_audited_epoch
    FROM projects p
    LEFT JOIN audits a ON p.id = a.project_id
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
    lastAuditedEpoch: typeof r.last_audited_epoch === "number" ? r.last_audited_epoch : null,
  }));

  if (targetDomainFilter) {
    candidates = candidates.filter((c) =>
      c.domain.toLowerCase() === targetDomainFilter,
    );
    if (candidates.length === 0) {
      console.error(`[ERROR] Target domain '${targetDomainFilter}' was not found among enrolled projects in shared-workspace.`);
      process.exit(1);
    }
  }

  const shouldSkipRecent = args.values["no-skip-recent"] ? false : !!args.values["skip-recent"];
  if (shouldSkipRecent && !targetDomainFilter) {
    const tenDaysAgoEpoch = Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000);
    candidates = candidates.filter(
      (c) => c.lastAuditedEpoch === null || c.lastAuditedEpoch === undefined || c.lastAuditedEpoch < tenDaysAgoEpoch,
    );
  }

  if (limit) {
    candidates = candidates.slice(0, limit);
  }

  console.log(`Queue populated with ${candidates.length} candidate projects.`);

  // Process queue with concurrency window
  const activeAudits = new Map<
    string,
    { auditId: string; project: TargetProject; startedAt: number }
  >();
  let queueIndex = 0;
  let completedCount = 0;
  let failedCount = 0;

  async function pollActiveAudits() {
    for (const [auditId, info] of Array.from(activeAudits.entries())) {
      const statusRows = runD1Query(
        `SELECT status, pages_crawled, current_phase, error_code FROM audits WHERE id = '${auditId}';`,
        isRemote,
      );
      if (statusRows.length === 0) {
        console.warn(`[WARNING] Audit ${auditId} for ${info.project.domain} not found in database.`);
        activeAudits.delete(auditId);
        failedCount++;
        continue;
      }

      if (Date.now() - info.startedAt > 15 * 60 * 1000) {
        console.warn(`[TIMEOUT] Audit ${auditId} for ${info.project.domain} exceeded 15-minute polling deadline.`);
        activeAudits.delete(auditId);
        failedCount++;
        continue;
      }

      const audit = statusRows[0];
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

  while (queueIndex < candidates.length || activeAudits.size > 0) {
    // Fill concurrency window
    while (activeAudits.size < concurrency && queueIndex < candidates.length) {
      const project = candidates[queueIndex++];
      const auditId = crypto.randomUUID();
      const startUrl = `https://${project.domain}`;

      const config = {
        maxPages,
        lighthouseStrategy: "auto",
        renderJavaScript: false,
      };

      console.log(`[DISPATCH] Launching audit on ${project.domain} (${startUrl}) [ID: ${auditId}]`);

      // 1. Insert audit row in D1
      const insertSql = `
        INSERT INTO audits (
          id, project_id, started_by_user_id, start_url,
          workflow_instance_id, config, status, pages_crawled,
          pages_total, lighthouse_total, current_phase, started_at
        ) VALUES (
          '${auditId}', '${project.id}', 'system', '${startUrl}',
          '${auditId}', '${JSON.stringify(config).replace(/'/g, "''")}', 'running', 0,
          ${maxPages}, 20, 'discovery', datetime('now')
        );
      `;
      runD1Query(insertSql, isRemote);

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

      const ok = triggerWorkflow(target.workflow, auditId, params, isRemote);
      if (ok) {
        activeAudits.set(auditId, {
          auditId,
          project,
          startedAt: Date.now(),
        });
      } else {
        console.error(`[ERROR] Failed to start workflow for ${project.domain}`);
        const failSql = `UPDATE audits SET status = 'failed', error_code = 'DISPATCH_ERROR', completed_at = datetime('now') WHERE id = '${auditId}' AND status = 'running' RETURNING id;`;
        const failedRows = runD1Query(failSql, isRemote);
        if (!failedRows || failedRows.length === 0) {
          console.warn(`[WARN] Dispatch error update for ${auditId} updated 0 rows (audit already terminal).`);
        }
        failedCount++;
      }
    }

    // Wait 10 seconds between polls
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await pollActiveAudits();
  }

  console.log("\n=== Fleet Audit Run Finished ===");
  console.log(`Total Completed: ${completedCount}`);
  console.log(`Total Failed: ${failedCount}`);
  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal fleet audit runner error:", err);
  process.exit(1);
});
