/**
 * Generator script to create SQL for enrolling all fleet & accessible GitHub properties
 * into OpenSEO D1 `projects` under `shared-workspace`, and linking `fleet_roster_members.project_id`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";

interface ManifestMember {
  canonicalHost: string;
  category: string;
  categoryEmoji?: string;
  tier?: string;
  siteIntent?: string;
  platform?: string;
  repoName?: string;
  clusterSlug?: string;
}

const MANIFEST_PATH = resolve(
  "src/server/features/fleet/data/fleetManifest.json",
);
const GITHUB_EVIDENCE_PATH = resolve(
  "C:/Users/THINKPAD/OneDrive/MD/PORTFOLIO/EVIDENCE/PROJECTS_GITHUB.md",
);
const OUTPUT_SQL_PATH = resolve("scratch/link_fleet_projects.sql");

// Currently known 13 existing domains in D1
const EXISTING_DOMAINS = new Set([
  "toiletcubicle.co.id",
  "taman.co.id",
  "besi.co.id",
  "fasad.co.id",
  "kaca.co.id",
  "epoxy.co.id",
  "furnitur.co.id",
  "realtor.id",
  "franchisor.id",
  "safety.co.id",
  "weddingevent.co.id",
  "duit.co.id",
  "codev.id",
]);

function formatDomainName(domain: string, repoName?: string): string {
  if (repoName) {
    const clean = repoName.replace(/^cfpages-[^/]+\//, "");
    if (clean) return clean;
  }
  return domain
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(".");
}

function run() {
  const manifestRaw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest: ManifestMember[] = JSON.parse(manifestRaw);

  const ghRaw = readFileSync(GITHUB_EVIDENCE_PATH, "utf8");
  const ghLines = ghRaw.split("\n");

  const targetMap = new Map<
    string,
    { domain: string; name: string; category: string; source: string }
  >();

  // 1. Add all 87 canonical properties from manifest
  for (const m of manifest) {
    const norm = m.canonicalHost.toLowerCase().trim();
    if (!norm) continue;
    targetMap.set(norm, {
      domain: norm,
      name: formatDomainName(norm, m.repoName),
      category: m.category,
      source: "manifest",
    });
  }

  // 2. Add accessible GitHub sites (200 / Active)
  for (const line of ghLines) {
    const match = line.match(
      /^\|\s*([^|]+)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*([^|]+)\|/,
    );
    if (!match) continue;
    const owner = match[1].trim();
    const repo = match[2].trim();
    const rawSite = match[3].trim().toLowerCase();
    const status = match[4].trim();

    if (status.includes("200") || status.includes("Active")) {
      const norm = rawSite.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (!norm) continue;

      if (!targetMap.has(norm)) {
        targetMap.set(norm, {
          domain: norm,
          name: repo || formatDomainName(norm),
          category: "GitHub Fleet",
          source: `github:${owner}/${repo}`,
        });
      } else {
        const existing = targetMap.get(norm)!;
        if (!existing.name || existing.name === norm) {
          existing.name = repo;
        }
      }
    }
  }

  console.log(`Total target properties resolved: ${targetMap.size}`);

  const insertStatements: string[] = [];
  let newlyEnrolledCount = 0;

  for (const [domain, meta] of targetMap.entries()) {
    if (EXISTING_DOMAINS.has(domain)) {
      continue; // Skip already created cluster parents
    }

    const projectId = crypto.randomUUID();
    const escapedName = meta.name.replace(/'/g, "''");
    const escapedDomain = domain.replace(/'/g, "''");

    insertStatements.push(
      `INSERT INTO projects (id, organization_id, name, domain, location_code, language_code, created_at) VALUES ('${projectId}', 'shared-workspace', '${escapedName}', '${escapedDomain}', 2360, 'id', datetime('now'));`,
    );
    newlyEnrolledCount++;
  }

  const updateRosterStatement = `
-- Link all 87 fleet roster members to their enrolled project
UPDATE fleet_roster_members
SET project_id = (
  SELECT p.id
  FROM projects p
  WHERE LOWER(p.domain) = LOWER(fleet_roster_members.canonical_host)
    AND p.organization_id = 'shared-workspace'
    AND p.archived_at IS NULL
  ORDER BY p.created_at ASC
  LIMIT 1
)
WHERE version_id = 'roster-shared-workspace-2026-11-22-v1';
`;

  const fullSql = [
    "-- OpenSEO Fleet Project Enrollment & Linking Migration",
    `-- Generated: ${new Date().toISOString()}`,
    `-- Total Target Domains: ${targetMap.size} | Newly Enrolled: ${newlyEnrolledCount}`,
    "",
    ...insertStatements,
    "",
    updateRosterStatement,
    "",
    "-- Verification Queries",
    "SELECT count(*) as total_projects FROM projects WHERE organization_id = 'shared-workspace';",
    "SELECT count(*) as total_roster, count(project_id) as linked_roster FROM fleet_roster_members WHERE version_id = 'roster-shared-workspace-2026-11-22-v1';",
  ].join("\n");

  writeFileSync(OUTPUT_SQL_PATH, fullSql, "utf8");
  console.log(
    `Wrote ${insertStatements.length} insert statements to ${OUTPUT_SQL_PATH}`,
  );
}

run();
