import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { executeD1SqlBatches } from "./github-archive-utils";

let args;
try {
  args = parseArgs({
    options: {
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
  console.error("[ERROR] Conflicting flags: cannot specify both --remote and --local.");
  process.exit(1);
}

const isRemote = args.values.local ? false : true;

function runD1Query(query: string): any[] {
  return executeD1SqlBatches([query], isRemote);
}

async function main() {
  console.log(`=== OpenSEO Fleet Status Summary (${isRemote ? "Remote D1" : "Local D1"}) ===`);

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

  // 3. Mutually exclusive coverage stats on eligible domain population (Sol F03, F10)
  const auditedStats = runD1Query(`
    WITH latest_attempt AS (
      SELECT p.id AS project_id, p.domain,
             a.id AS latest_audit_id,
             a.status AS latest_status
      FROM projects p
      LEFT JOIN audits a ON a.id = (
        SELECT a2.id FROM audits a2
        WHERE a2.project_id = p.id
        ORDER BY julianday(a2.started_at) DESC NULLS LAST, a2.id DESC
        LIMIT 1
      )
      WHERE p.organization_id = 'shared-workspace'
        AND p.domain IS NOT NULL
        AND p.archived_at IS NULL
    )
    SELECT
      COUNT(*) AS total_enrolled_domains,
      COUNT(*) FILTER (WHERE latest_status = 'completed') AS completed_projects,
      COUNT(*) FILTER (WHERE latest_status = 'running') AS running_projects,
      COUNT(*) FILTER (WHERE latest_status = 'failed') AS failed_projects,
      COUNT(*) FILTER (WHERE latest_audit_id IS NULL) AS never_audited_projects
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
    ORDER BY julianday(a.completed_at) DESC NULLS LAST, a.id DESC LIMIT 10;
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
    ORDER BY julianday(a.started_at) DESC NULLS LAST, a.id DESC LIMIT 10;
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
