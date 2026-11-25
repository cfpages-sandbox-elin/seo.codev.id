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
  sqlText,
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

  const effectiveRoster =
    selectEffectiveRosterVersion<RosterVersionRow>(rosterVersionsRaw);

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

  // 2. Fetch members of the effective roster version joined with active same-organization projects
  const members = runD1Query(
    `SELECT rm.id, rm.canonical_host, rm.project_id, rm.repo_name, rm.publish_root, p.domain, p.name
     FROM fleet_roster_members rm
     LEFT JOIN projects p ON p.id = rm.project_id
                         AND p.organization_id = 'shared-workspace'
                         AND p.archived_at IS NULL
                         AND lower(trim(p.domain)) = lower(trim(rm.canonical_host))
     WHERE rm.version_id = ${sqlText(effectiveRoster.id)}
       AND rm.enrollment_state = 'active';`,
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

  // 4. Query completed edge audits bound to active roster members (Sol T1, Round 17)
  const edgeAudits = runD1Query(
    `SELECT DISTINCT rm.id AS member_id
     FROM fleet_roster_members rm
     JOIN projects p ON p.id = rm.project_id
                    AND p.organization_id = 'shared-workspace'
                    AND p.archived_at IS NULL
                    AND lower(trim(p.domain)) = lower(trim(rm.canonical_host))
     JOIN audits a ON a.project_id = p.id
                  AND a.status = 'completed'
                  AND (a.workflow_instance_id NOT LIKE 'github-audit-%' OR a.workflow_instance_id IS NULL)
     WHERE rm.version_id = ${sqlText(effectiveRoster.id)}
       AND rm.enrollment_state = 'active';`,
    isRemote,
  );
  const edgeAuditedMemberIds = new Set(edgeAudits.map((a: any) => a.member_id));

  // 5. Query qualified repository audits bound to active roster members with verified diagnostic lineage (Sol T1, C1)
  const repoAudits = runD1Query(
    `SELECT DISTINCT rm.id AS member_id
     FROM fleet_roster_members rm
     JOIN projects p ON p.id = rm.project_id
                    AND p.organization_id = 'shared-workspace'
                    AND p.archived_at IS NULL
                    AND lower(trim(p.domain)) = lower(trim(rm.canonical_host))
     JOIN audits a ON a.project_id = p.id
                  AND a.status = 'completed'
                  AND a.workflow_instance_id LIKE 'github-audit-%'
                  AND a.pages_total > 0
                  AND a.pages_crawled >= a.pages_total
     JOIN fleet_run_items i ON i.audit_id = a.id
                           AND i.member_id = rm.id
                           AND i.project_id = p.id
                           AND i.primary_series_key = 'diagnostic'
                           AND i.status = 'completed'
     JOIN fleet_runs r ON r.id = i.run_id
                      AND r.roster_version_id = rm.version_id
                      AND r.organization_id = p.organization_id
                      AND r.status = 'completed'
     JOIN fleet_snapshots s ON s.run_item_id = i.id
                           AND s.member_id = rm.id
                           AND s.project_id = p.id
                           AND lower(trim(s.canonical_host)) = lower(trim(rm.canonical_host))
                           AND s.series_key = 'diagnostic'
     WHERE rm.version_id = ${sqlText(effectiveRoster.id)}
       AND rm.enrollment_state = 'active'
       AND rm.repo_name IS NOT NULL
       AND CASE WHEN json_valid(a.config) THEN
         json_extract(a.config, '$.source') = 'github_repository_direct'
         AND json_extract(a.config, '$.repoName') = rm.repo_name
         AND coalesce(json_extract(a.config, '$.publishRoot'), '.') = coalesce(rm.publish_root, '.')
         AND json_extract(a.config, '$.rosterSource.versionId') = rm.version_id
         AND json_extract(a.config, '$.rosterSource.memberId') = rm.id
         AND json_extract(a.config, '$.rosterSource.projectId') = rm.project_id
         AND lower(trim(json_extract(a.config, '$.rosterSource.canonicalHost'))) = lower(trim(rm.canonical_host))
         AND json_extract(a.config, '$.rosterSource.repoName') = rm.repo_name
         AND json_type(a.config, '$.rosterSource.publishRoot') = 'text'
          AND json_extract(a.config, '$.rosterSource.publishRoot') = coalesce(rm.publish_root, '.')
       ELSE 0 END;`,
    isRemote,
  );
  const repoQualifiedMemberIds = new Set(
    repoAudits.map((a: any) => a.member_id),
  );

  // 6. Aggregate metrics across roster members keyed by member id
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
    const hasRepo = Boolean(effectiveRepo);

    if (hasRepo) {
      mapped++;
    } else {
      unmapped++;
      unmappedList.push({ domain: dom, id: m.id });
    }

    const isEdgeAudited = edgeAuditedMemberIds.has(m.id);
    const isRepoQualified = repoQualifiedMemberIds.has(m.id);

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
        id: m.id,
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

  if (args.values.local && process.argv.includes("--remote")) {
    console.error(
      "[ERROR] Conflicting flags: cannot specify both --remote and --local.",
    );
    process.exit(1);
  }
  if (args.positionals.length > 0) {
    console.error(
      `[ERROR] Unexpected positional arguments: ${args.positionals.join(" ")}`,
    );
    process.exit(1);
  }

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
