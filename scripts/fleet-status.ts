import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const sanitized = query.replace(/\r?\n/g, " ").trim();
  const cmd = `npx wrangler d1 execute open-seo-db-selfhost --remote --json --command "${sanitized.replace(/"/g, '\\"')}"`;
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

async function main() {
  console.log("=== OpenSEO Fleet Status Summary ===");

  // 1. Audit status breakdown
  const auditStatus = runD1Query(
    "SELECT status, count(*) as count FROM audits GROUP BY status;"
  );
  console.log("Audits by status:", auditStatus);

  // 2. Total enrolled projects in shared-workspace
  const projectStats = runD1Query(
    "SELECT count(*) as total_projects FROM projects WHERE organization_id = 'shared-workspace' AND archived_at IS NULL;"
  );
  console.log("Total active projects:", projectStats[0]?.total_projects);

  // 3. Audited vs Unaudiated
  const auditedStats = runD1Query(`
    SELECT
      COUNT(DISTINCT p.id) as total_enrolled,
      COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN p.id END) as audited_projects,
      COUNT(DISTINCT CASE WHEN a.status = 'running' THEN p.id END) as running_projects,
      COUNT(DISTINCT CASE WHEN a.status = 'failed' AND a2.id IS NULL THEN p.id END) as only_failed_projects
    FROM projects p
    LEFT JOIN audits a ON p.id = a.project_id
    LEFT JOIN audits a2 ON p.id = a2.project_id AND a2.status = 'completed'
    WHERE p.organization_id = 'shared-workspace' AND p.archived_at IS NULL;
  `);
  console.log("Audited coverage stats:", auditedStats[0]);

  // 4. Recent completed audits
  const recentCompleted = runD1Query(`
    SELECT a.id, p.domain, a.pages_crawled, a.started_at, a.completed_at
    FROM audits a
    JOIN projects p ON a.project_id = p.id
    WHERE a.status = 'completed'
    ORDER BY a.completed_at DESC LIMIT 10;
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
    ORDER BY a.started_at DESC LIMIT 10;
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
