import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeD1SqlBatches } from "./github-archive-utils";

const ENV_FILE = resolve("C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/.env.selfhost");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
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

function runD1Query(query: string): any[] {
  return executeD1SqlBatches([query], true);
}

async function main() {
  console.log("=== OpenSEO Fleet Status Summary ===");

  // 1. Audit status breakdown (scoped to shared-workspace and active projects)
  const auditStatus = runD1Query(`
    SELECT a.status, count(*) as count
    FROM audits a
    JOIN projects p ON a.project_id = p.id
    WHERE p.organization_id = 'shared-workspace' AND p.archived_at IS NULL
    GROUP BY a.status;
  `);
  console.log("Audits by status:", auditStatus);

  // 2. Total enrolled projects in shared-workspace
  const projectStats = runD1Query(
    "SELECT count(*) as total_projects FROM projects WHERE organization_id = 'shared-workspace' AND archived_at IS NULL;"
  );
  console.log("Total active projects:", projectStats[0]?.total_projects);

  // 3. Mutually exclusive coverage stats on eligible domain population (Sol F11)
  const auditedStats = runD1Query(`
    WITH latest_attempt AS (
      SELECT p.id AS project_id, p.domain,
             a.id AS latest_audit_id,
             a.status AS latest_status
      FROM projects p
      LEFT JOIN audits a ON a.id = (
        SELECT a2.id FROM audits a2
        WHERE a2.project_id = p.id
        ORDER BY unixepoch(a2.created_at) DESC, a2.id DESC
        LIMIT 1
      )
      WHERE p.organization_id = 'shared-workspace'
        AND p.domain IS NOT NULL
        AND p.archived_at IS NULL
    )
    SELECT
      COUNT(*) AS total_enrolled_domains,
      SUM(CASE WHEN latest_status = 'completed' THEN 1 ELSE 0 END) AS completed_projects,
      SUM(CASE WHEN latest_status = 'running' THEN 1 ELSE 0 END) AS running_projects,
      SUM(CASE WHEN latest_status = 'failed' THEN 1 ELSE 0 END) AS failed_projects,
      SUM(CASE WHEN latest_audit_id IS NULL THEN 1 ELSE 0 END) AS never_audited_projects
    FROM latest_attempt;
  `);
  console.log("Audited coverage stats (mutually exclusive):", auditedStats[0]);

  // 4. Recent completed audits
  const recentCompleted = runD1Query(`
    SELECT a.id, p.domain, a.pages_crawled, a.started_at, a.completed_at
    FROM audits a
    JOIN projects p ON a.project_id = p.id
    WHERE a.status = 'completed'
      AND p.organization_id = 'shared-workspace'
      AND p.archived_at IS NULL
    ORDER BY unixepoch(a.completed_at) DESC, a.id DESC LIMIT 10;
  `);
  console.log("\nRecent completed audits (sample 10):");
  for (const r of recentCompleted) {
    console.log(`- ${r.domain}: ${r.pages_crawled} pages (${r.completed_at})`);
  }

  // 5. Failed audits sample
  const failedAudits = runD1Query(`
    SELECT a.id, p.domain, a.error_code, a.current_phase, a.started_at
    FROM audits a
    JOIN projects p ON a.project_id = p.id
    WHERE a.status = 'failed'
      AND p.organization_id = 'shared-workspace'
      AND p.archived_at IS NULL
    ORDER BY unixepoch(a.started_at) DESC, a.id DESC LIMIT 10;
  `);
  console.log("\nRecent failed audits (sample 10):");
  for (const f of failedAudits) {
    console.log(`- ${f.domain}: error=${f.error_code}, phase=${f.current_phase}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
