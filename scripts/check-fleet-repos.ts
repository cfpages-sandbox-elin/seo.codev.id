/**
 * Self-Contained D1 Fleet Repository Coverage & Audit Verification CLI (PRD §4.3, FLEET-ROSTER-01, Sol T1)
 *
 * Evaluates repository mappings and audit completion status strictly from D1 state,
 * scoping all metrics to the effective approved fleet roster version.
 * Distinguishes runtime edge audits from repository audits qualified with verified diagnostic triples.
 *
 * Usage:
 *   pnpm exec tsx scripts/check-fleet-repos.ts [--remote|--local] [--json]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  executeD1SqlBatches,
  selectEffectiveRosterVersion,
} from "./github-archive-utils";

interface RosterVersionRow {
  id: string;
  approved_at: string | null;
  domain_count: number | null;
}

interface RosterMemberRow {
  id: string;
  canonical_host: string;
  project_id: string | null;
  repo_name: string | null;
  domain?: string | null;
  name?: string | null;
}

export function runD1Query(query: string, isRemote: boolean): any[] {
  return executeD1SqlBatches([query], isRemote);
}

export function checkFleetCoverage(options?: {
  remote?: boolean;
  manifestFile?: string;
  projectsGithubFile?: string;
}) {
  const isRemote = options?.remote ?? true;
  const manifestFile =
    options?.manifestFile ??
    resolve("src/server/features/fleet/data/fleetManifest.json");
  const projectsGithubFile =
    options?.projectsGithubFile ??
    resolve(
      "C:/Users/THINKPAD/OneDrive/MD/PORTFOLIO/EVIDENCE/PROJECTS_GITHUB.md",
    );

  // 1. Fetch effective approved roster version from D1
  const rosterVersionsRaw = runD1Query(
    "SELECT id, approved_at, domain_count FROM fleet_roster_versions WHERE approved_at IS NOT NULL AND organization_id = 'shared-workspace';",
    isRemote,
  );

  const effectiveRoster = selectEffectiveRosterVersion<RosterVersionRow>(
    rosterVersionsRaw,
  );

  if (!effectiveRoster) {
    return {
      rosterId: null,
      denominator: 0,
      mapped: 0,
      unmapped: 0,
      edgeCompleted: 0,
      repoQualified: 0,
      both: 0,
      edgeOnly: 0,
      repoOnly: 0,
      neither: 0,
      unmappedList: [],
      unauditedList: [],
    };
  }

  // 2. Fetch members of the effective roster version
  const members = runD1Query(
    `SELECT rm.id, rm.canonical_host, rm.project_id, rm.repo_name, p.domain, p.name
     FROM fleet_roster_members rm
     LEFT JOIN projects p ON p.id = rm.project_id AND p.organization_id = 'shared-workspace' AND p.archived_at IS NULL
     WHERE rm.version_id = '${effectiveRoster.id}';`,
    isRemote,
  ) as RosterMemberRow[];

  // 3. Supplemental host repository mappings (optional, non-throwing)
  const repoByDomain = new Map<string, string>();
  if (manifestFile && existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (Array.isArray(manifest)) {
        for (const m of manifest) {
          if (m.canonicalHost && m.repoName) {
            repoByDomain.set(
              m.canonicalHost.toLowerCase().trim(),
              m.repoName.trim(),
            );
          }
        }
      }
    } catch {}
  }

  if (projectsGithubFile && existsSync(projectsGithubFile)) {
    try {
      const ghRaw = readFileSync(projectsGithubFile, "utf8");
      for (const line of ghRaw.split(/\r?\n/)) {
        const match = line.match(
          /^\|\s*([^|]+)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*([^|]+)\|/,
        );
        if (match) {
          const owner = match[1].trim();
          const repo = match[2].trim();
          const site = match[3]
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "");
          if (!repoByDomain.has(site)) {
            repoByDomain.set(site, `${owner}/${repo}`);
          }
        }
      }
    } catch {}
  }

  // 4. Query completed edge audits
  const edgeAudits = runD1Query(
    "SELECT DISTINCT project_id FROM audits WHERE status = 'completed' AND (workflow_instance_id NOT LIKE 'github-audit-%' OR workflow_instance_id IS NULL) AND project_id IS NOT NULL;",
    isRemote,
  );
  const edgeAuditedProjectIds = new Set(
    edgeAudits.map((a: any) => a.project_id),
  );

  // 5. Query qualified repository audits (Sol A3 / T1: requires verified diagnostic triple)
  const repoAudits = runD1Query(
    `SELECT DISTINCT a.project_id
     FROM audits a
     WHERE a.status = 'completed'
       AND a.workflow_instance_id LIKE 'github-audit-%'
       AND a.project_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM fleet_snapshots fs
         JOIN fleet_run_items fri ON fri.id = fs.run_item_id AND fri.status = 'completed'
         JOIN fleet_runs fr ON fr.id = fri.run_id AND fr.status = 'completed'
         WHERE fri.audit_id = a.id AND fs.series_key = 'diagnostic'
       );`,
    isRemote,
  );
  const repoQualifiedProjectIds = new Set(
    repoAudits.map((a: any) => a.project_id),
  );

  // 6. Aggregate metrics across roster members
  let mapped = 0;
  let unmapped = 0;
  let edgeCompleted = 0;
  let repoQualified = 0;
  let both = 0;
  let edgeOnly = 0;
  let repoOnly = 0;
  let neither = 0;

  const unmappedList: { domain: string; id: string }[] = [];
  const unauditedList: { domain: string; repo?: string; id: string }[] = [];

  for (const m of members) {
    const dom = m.canonical_host.toLowerCase().trim();
    const effectiveRepo = m.repo_name || repoByDomain.get(dom);
    const projId = m.project_id;

    const hasRepo = Boolean(effectiveRepo);
    if (hasRepo) {
      mapped++;
    } else {
      unmapped++;
      unmappedList.push({ domain: dom, id: m.id });
    }

    const isEdgeAudited = Boolean(projId && edgeAuditedProjectIds.has(projId));
    const isRepoQualified = Boolean(
      projId && repoQualifiedProjectIds.has(projId),
    );

    if (isEdgeAudited) edgeCompleted++;
    if (isRepoQualified) repoQualified++;

    if (isEdgeAudited && isRepoQualified) {
      both++;
    } else if (isEdgeAudited && !isRepoQualified) {
      edgeOnly++;
    } else if (!isEdgeAudited && isRepoQualified) {
      repoOnly++;
    } else {
      neither++;
      unauditedList.push({
        domain: dom,
        repo: effectiveRepo,
        id: projId || m.id,
      });
    }
  }

  return {
    rosterId: effectiveRoster.id,
    denominator: members.length,
    mapped,
    unmapped,
    edgeCompleted,
    repoQualified,
    both,
    edgeOnly,
    repoOnly,
    neither,
    unmappedList,
    unauditedList,
  };
}

async function main() {
  const args = parseArgs({
    options: {
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const isRemote = args.values.local ? false : (args.values.remote ?? true);
  const result = checkFleetCoverage({ remote: isRemote });

  if (args.values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("==========================================================");
  console.log("OpenSEO Fleet Coverage & Audit Verification Report");
  console.log("==========================================================");
  console.log(`Effective Roster ID:        ${result.rosterId ?? "None"}`);
  console.log(`Enrolled Properties (Denom): ${result.denominator}`);
  console.log(`Mapped with Repository:     ${result.mapped}`);
  console.log(`Unmapped (No Repository):   ${result.unmapped}`);
  console.log("----------------------------------------------------------");
  console.log("Audit Coverage by Lane:");
  console.log(`  - Runtime Edge Completed:   ${result.edgeCompleted}`);
  console.log(`  - Repo Qualified (Triple):  ${result.repoQualified}`);
  console.log(`  - Both Lanes Completed:     ${result.both}`);
  console.log(`  - Edge Only:                ${result.edgeOnly}`);
  console.log(`  - Repo Qualified Only:      ${result.repoOnly}`);
  console.log(`  - Neither Lane Completed:   ${result.neither}`);
  console.log("==========================================================");

  if (result.unmappedList.length > 0) {
    console.log(
      `Sample unmapped properties (${Math.min(5, result.unmappedList.length)}):`,
      result.unmappedList.slice(0, 5),
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith("check-fleet-repos.ts")) {
  main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}
