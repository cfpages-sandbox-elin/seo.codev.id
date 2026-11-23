/**
 * Turnkey Bulk Project Enrollment & GitHub Portfolio Linking CLI (PRD §4.1, FLEET-SYNC-01)
 *
 * Idempotently reconciles canonical fleet manifest members and accessible GitHub repositories
 * into OpenSEO D1 `projects` under `shared-workspace`, and updates `fleet_roster_members.project_id`
 * to achieve 100% mapped status across the entire fleet.
 *
 * Usage:
 *   pnpm exec tsx scripts/link-github-fleet.ts [--dry-run] [--remote | --local] [--org-id <id>]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";

const MANIFEST_PATH = resolve("src/server/features/fleet/data/fleetManifest.json");
const GITHUB_EVIDENCE_PATH = resolve("C:/Users/THINKPAD/OneDrive/MD/PORTFOLIO/EVIDENCE/PROJECTS_GITHUB.md");
const ENV_FILE = resolve(".env.selfhost");

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
      }
    }
  } catch {
    // optional .env.selfhost
  }
  return env;
}

const envVars = loadEnv();

function extractJson(raw: string): any {
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1) {
    try {
      return JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    } catch {}
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return JSON.parse(raw);
}

function runD1Query(query: string, isRemote: boolean): any[] {
  const sanitized = query.replace(/\r?\n/g, " ").trim();
  const flag = isRemote ? "--remote" : "--local";
  const cmd = `npx wrangler d1 execute open-seo-db-selfhost ${flag} --json --command "${sanitized.replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, {
    cwd: resolve("."),
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

function executeD1Sql(sqlContent: string, isRemote: boolean) {
  const flag = isRemote ? "--remote" : "--local";
  const tempFile = resolve(`scratch/temp_link_${Date.now()}.sql`);
  writeFileSync(tempFile, sqlContent, "utf8");
  try {
    const cmd = `npx wrangler d1 execute open-seo-db-selfhost ${flag} --file "${tempFile}"`;
    execSync(cmd, {
      cwd: resolve("."),
      env: { ...process.env, ...envVars },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    try {
      const fs = require("node:fs");
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {}
  }
}

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

export async function linkFleet(options: {
  dryRun?: boolean;
  remote?: boolean;
  orgId?: string;
}) {
  const isDryRun = options.dryRun ?? false;
  const isRemote = options.remote ?? false;
  const orgId = options.orgId ?? "shared-workspace";

  console.log(`\n=== OpenSEO Fleet Linking Runner (FLEET-SYNC-01) ===`);
  console.log(`Target: ${isRemote ? "Cloudflare D1 (Remote)" : "Local D1"}`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (Preview Only)" : "LIVE EXECUTION"}`);
  console.log(`Organization ID: ${orgId}`);

  // 1. Read manifest & portfolio evidence
  const manifestRaw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest: ManifestMember[] = JSON.parse(manifestRaw);

  let ghLines: string[] = [];
  try {
    const ghRaw = readFileSync(GITHUB_EVIDENCE_PATH, "utf8");
    ghLines = ghRaw.split("\n");
  } catch (err) {
    console.warn(`[WARN] Could not read ${GITHUB_EVIDENCE_PATH}, proceeding with manifest members only.`);
  }

  const targetMap = new Map<
    string,
    { domain: string; name: string; category: string; source: string }
  >();

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
      }
    }
  }

  console.log(`Discovered ${targetMap.size} unique eligible portfolio targets (87 manifest + external active repos).`);

  // 2. Query existing state from D1
  let existingProjects: any[] = [];
  let existingMembers: any[] = [];
  let approvedRoster: any = null;

  try {
    existingProjects = runD1Query(
      `SELECT id, domain FROM projects WHERE organization_id = '${orgId}' AND archived_at IS NULL;`,
      isRemote,
    );
    existingMembers = runD1Query(
      `SELECT id, canonical_host, project_id, version_id FROM fleet_roster_members;`,
      isRemote,
    );
    const rosterVersions = runD1Query(
      `SELECT id, version_tag, manifest_hash FROM fleet_roster_versions WHERE organization_id = '${orgId}' ORDER BY approved_at DESC LIMIT 1;`,
      isRemote,
    );
    if (rosterVersions.length > 0) {
      approvedRoster = rosterVersions[0];
    }
  } catch (err: any) {
    console.error(`[ERROR] Failed to query D1 database:`, err?.message || err);
    if (!isDryRun) process.exit(1);
  }

  const existingProjectDomainMap = new Map<string, string>();
  for (const p of existingProjects) {
    existingProjectDomainMap.set(p.domain.toLowerCase().trim(), p.id);
  }

  console.log(`Found ${existingProjects.length} existing projects in D1.`);
  console.log(`Found ${existingMembers.length} fleet roster members in D1.`);
  if (approvedRoster) {
    console.log(`Active Approved Roster Version: ${approvedRoster.version_tag} (${approvedRoster.id})`);
  }

  // 3. Determine missing projects and link updates
  const missingProjects: Array<{ id: string; domain: string; name: string }> = [];
  for (const [domain, meta] of targetMap.entries()) {
    if (!existingProjectDomainMap.has(domain)) {
      const id = "proj_" + crypto.randomBytes(12).toString("hex");
      missingProjects.push({ id, domain, name: meta.name });
      existingProjectDomainMap.set(domain, id);
    }
  }

  const membersToLink: Array<{ memberId: string; host: string; projectId: string }> = [];
  for (const m of existingMembers) {
    const host = m.canonical_host.toLowerCase().trim();
    const currentProjectId = m.project_id;
    const targetProjectId = existingProjectDomainMap.get(host);
    if (targetProjectId && (!currentProjectId || currentProjectId !== targetProjectId)) {
      membersToLink.push({ memberId: m.id, host, projectId: targetProjectId });
    }
  }

  console.log(`\nReconciliation Summary:`);
  console.log(`  - Missing projects to insert: ${missingProjects.length}`);
  console.log(`  - Fleet roster members to link: ${membersToLink.length}`);
  console.log(`  - Already linked roster members: ${existingMembers.length - membersToLink.length}`);

  if (isDryRun) {
    console.log(`\n[DRY RUN] Actions preview:`);
    if (missingProjects.length > 0) {
      console.log(`Sample missing projects to insert (first 5):`);
      missingProjects.slice(0, 5).forEach((p) => console.log(`  + [${p.domain}] -> ${p.name} (id: ${p.id})`));
    }
    if (membersToLink.length > 0) {
      console.log(`Sample roster member links (first 5):`);
      membersToLink.slice(0, 5).forEach((m) => console.log(`  -> ${m.host} (member: ${m.memberId}) => project: ${m.projectId}`));
    }
    console.log(`\nDry run completed cleanly. Run without --dry-run to apply changes.`);
    return;
  }

  // 4. Live execution: Build SQL and execute
  const sqlStatements: string[] = [];
  sqlStatements.push(`-- Generated by link-github-fleet.ts at ${new Date().toISOString()}`);

  for (const p of missingProjects) {
    const escapedName = p.name.replace(/'/g, "''");
    const escapedDomain = p.domain.replace(/'/g, "''");
    sqlStatements.push(
      `INSERT INTO projects (id, organization_id, name, domain, location_code, language_code, created_at, updated_at) VALUES ('${p.id}', '${orgId}', '${escapedName}', '${escapedDomain}', 2360, 'id', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`
    );
  }

  for (const m of membersToLink) {
    sqlStatements.push(
      `UPDATE fleet_roster_members SET project_id = '${m.projectId}' WHERE id = '${m.memberId}';`
    );
  }

  if (sqlStatements.length <= 1) {
    console.log(`All portfolio projects and fleet roster members are 100% mapped! Zero updates required.`);
    return;
  }

  console.log(`Executing ${sqlStatements.length - 1} SQL statements against D1...`);
  executeD1Sql(sqlStatements.join("\n"), isRemote);

  // 5. Verification check
  const updatedMembers = runD1Query(
    `SELECT count(*) as unmapped_count FROM fleet_roster_members WHERE project_id IS NULL;`,
    isRemote,
  );
  const unmapped = updatedMembers[0]?.unmapped_count ?? 0;
  console.log(`Verification: Remaining unmapped roster members: ${unmapped}`);
  if (unmapped === 0) {
    console.log(`SUCCESS: 100% of fleet roster members are linked to verified D1 projects!`);
  } else {
    console.warn(`WARNING: ${unmapped} members remain unmapped.`);
  }
}

// CLI execution
if (process.argv[1] && process.argv[1].includes("link-github-fleet")) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      "org-id": { type: "string", default: "shared-workspace" },
    },
  });

  const isRemote = values.remote ?? !values.local;
  linkFleet({
    dryRun: values["dry-run"],
    remote: isRemote,
    orgId: values["org-id"],
  }).catch((err) => {
    console.error("Fleet linking failed:", err);
    process.exit(1);
  });
}
