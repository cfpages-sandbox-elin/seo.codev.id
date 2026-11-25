/**
 * Turnkey Bulk Project Enrollment & GitHub Portfolio Linking CLI (PRD §4.1, FLEET-SYNC-01)
 *
 * Idempotently reconciles canonical fleet manifest members and accessible GitHub repositories
 * into OpenSEO D1 `projects` under the target organization, and updates `fleet_roster_members.project_id`
 * scoped strictly to the approved roster version and organization.
 *
 * Usage:
 *   pnpm exec tsx scripts/link-github-fleet.ts [--dry-run] [--remote | --local] [--org-id <id>]
 */
import { execSync } from "node:child_process";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import {
  selectEffectiveRosterVersion,
  executeD1SqlBatches,
} from "./github-archive-utils";

const MANIFEST_PATH = resolve(
  "src/server/features/fleet/data/fleetManifest.json",
);
const GITHUB_EVIDENCE_PATH = resolve(
  "C:/Users/THINKPAD/OneDrive/MD/PORTFOLIO/EVIDENCE/PROJECTS_GITHUB.md",
);
const ENV_FILE = resolve(".env.selfhost");

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
        env[key] = val;
      }
    }
  } catch {}
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
  return executeD1SqlBatches([query], isRemote);
}

function executeD1Sql(sqlContent: string, isRemote: boolean) {
  const statements = sqlContent
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  executeD1SqlBatches(statements, isRemote);
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

  // Sol P2-05: Validate organization ID against injection
  if (!/^[a-zA-Z0-9_-]+$/.test(orgId)) {
    throw new Error(
      `Invalid organization ID '${orgId}'. Must contain only alphanumeric, dash, or underscore characters.`,
    );
  }

  console.log(`\n=== OpenSEO Fleet Linking Runner (FLEET-SYNC-01) ===`);
  console.log(`Target: ${isRemote ? "Cloudflare D1 (Remote)" : "Local D1"}`);
  console.log(
    `Mode: ${isDryRun ? "DRY RUN (Preview Only)" : "LIVE EXECUTION"}`,
  );
  console.log(`Organization ID: ${orgId}`);

  // 1. Read manifest & portfolio evidence
  const manifestRaw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest: ManifestMember[] = JSON.parse(manifestRaw);

  let ghLines: string[] = [];
  try {
    const ghRaw = readFileSync(GITHUB_EVIDENCE_PATH, "utf8");
    ghLines = ghRaw.split("\n");
  } catch {
    console.warn(
      `[WARN] Could not read ${GITHUB_EVIDENCE_PATH}, proceeding with manifest members only.`,
    );
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

  console.log(
    `Discovered ${targetMap.size} unique eligible portfolio targets (87 manifest + external active repos).`,
  );

  // 2. Query existing state from D1
  let existingProjects: any[] = [];
  let existingMembers: any[] = [];
  let approvedRoster: any = null;

  try {
    existingProjects = runD1Query(
      `SELECT id, domain FROM projects WHERE organization_id = '${orgId}' AND archived_at IS NULL;`,
      isRemote,
    );

    const rosterVersions = runD1Query(
      `SELECT id, version_tag, approved_at, domain_count, manifest_hash FROM fleet_roster_versions WHERE organization_id = '${orgId}';`,
      isRemote,
    );
    approvedRoster = selectEffectiveRosterVersion(rosterVersions);
    if (!approvedRoster) {
      throw new Error(
        `No effective approved roster version found for organization '${orgId}'.`,
      );
    }

    // Scoped strictly to the approved roster version to prevent mutating historical or foreign versions (P1-1)
    existingMembers = runD1Query(
      `SELECT id, canonical_host, project_id, version_id FROM fleet_roster_members WHERE version_id = '${approvedRoster.id}';`,
      isRemote,
    );
  } catch (err: any) {
    console.error(`[ERROR] Failed to query D1 database:`, err?.message || err);
    throw err; // Fail closed: unreadable state must not produce a clean dry run or blind apply
  }

  const existingProjectDomainMap = new Map<string, string>();
  const duplicateCandidates = new Set<string>();
  for (const p of existingProjects) {
    if (p.domain) {
      const normHost = p.domain.toLowerCase().trim();
      if (existingProjectDomainMap.has(normHost)) {
        duplicateCandidates.add(normHost);
      } else {
        existingProjectDomainMap.set(normHost, p.id);
      }
    }
  }
  if (duplicateCandidates.size > 0) {
    throw new Error(
      `Ambiguous project candidates: duplicate active projects found in organization '${orgId}' for domain(s): ${Array.from(duplicateCandidates).join(", ")}. Resolve ambiguity before linking.`,
    );
  }

  console.log(`Found ${existingProjects.length} existing projects in D1.`);
  console.log(
    `Found ${existingMembers.length} fleet roster members in approved roster ${approvedRoster.id}.`,
  );
  console.log(
    `Active Approved Roster Version: ${approvedRoster.version_tag} (${approvedRoster.id})`,
  );

  // 3. Determine missing projects and link updates (Sol R24-09: align preview and apply write scope)
  const activeApprovedRosterHosts = new Set(
    existingMembers
      .filter((m) => m.enrollment_state === "active")
      .map((m) => m.canonical_host.toLowerCase().trim()),
  );

  const missingProjects: Array<{ id: string; domain: string; name: string }> =
    [];
  const outsideRosterInventory: Array<{
    domain: string;
    name: string;
    source: string;
  }> = [];

  for (const [domain, meta] of targetMap.entries()) {
    if (activeApprovedRosterHosts.has(domain)) {
      if (!existingProjectDomainMap.has(domain)) {
        const id = crypto.randomUUID(); // Standard UUID convention (P1-1)
        missingProjects.push({ id, domain, name: meta.name });
        existingProjectDomainMap.set(domain, id);
      }
    } else {
      outsideRosterInventory.push({
        domain,
        name: meta.name,
        source: meta.source,
      });
    }
  }

  const membersToLink: Array<{
    memberId: string;
    host: string;
    projectId: string;
  }> = [];
  for (const m of existingMembers) {
    if (m.enrollment_state !== "active") continue;
    const host = m.canonical_host.toLowerCase().trim();
    const currentProjectId = m.project_id;
    const targetProjectId = existingProjectDomainMap.get(host);
    // Only link if unmapped (project_id IS NULL) to preserve existing manual overrides
    if (targetProjectId && !currentProjectId) {
      membersToLink.push({ memberId: m.id, host, projectId: targetProjectId });
    }
  }

  const alreadyLinkedCount = existingMembers.filter(
    (m) => m.project_id !== null,
  ).length;
  const linkableCount = membersToLink.length;
  const inactiveCount = existingMembers.filter(
    (m) => m.enrollment_state !== "active",
  ).length;
  const unmappedCount = existingMembers.filter(
    (m) =>
      m.enrollment_state === "active" &&
      m.project_id === null &&
      !existingProjectDomainMap.has(m.canonical_host.toLowerCase().trim()),
  ).length;

  console.log(`\nReconciliation Summary:`);
  console.log(`  - Missing projects to insert: ${missingProjects.length}`);
  console.log(`  - Fleet roster members to link: ${linkableCount}`);
  console.log(`  - Already linked roster members: ${alreadyLinkedCount}`);
  console.log(`  - Inactive / parked roster members: ${inactiveCount}`);
  console.log(`  - Unmapped active roster members: ${unmappedCount}`);
  console.log(
    `  - Outside-roster inventory targets (skipped): ${outsideRosterInventory.length}`,
  );

  // Sol P2-01: Reconcile complete partition: total must equal alreadyLinked + linkable + unmapped + inactive
  const totalPartition =
    alreadyLinkedCount + linkableCount + unmappedCount + inactiveCount;
  if (totalPartition !== existingMembers.length) {
    throw new Error(
      `Reconciliation partition mismatch: partitioned ${totalPartition} members vs ${existingMembers.length} total members in approved roster.`,
    );
  }

  if (isDryRun) {
    console.log(`\n[DRY RUN] Actions preview:`);
    if (missingProjects.length > 0) {
      console.log(`Sample missing projects to insert (first 5):`);
      missingProjects
        .slice(0, 5)
        .forEach((p) =>
          console.log(`  + [${p.domain}] -> ${p.name} (id: ${p.id})`),
        );
    }
    if (membersToLink.length > 0) {
      console.log(`Sample roster member links (first 5):`);
      membersToLink
        .slice(0, 5)
        .forEach((m) =>
          console.log(
            `  -> ${m.host} (member: ${m.memberId}) => project: ${m.projectId}`,
          ),
        );
    }
    console.log(
      `\nDry run completed cleanly. Run without --dry-run to apply changes.`,
    );
    return;
  }

  // 4. Live execution: Build SQL and execute
  const sqlStatements: string[] = [];

  for (const p of missingProjects) {
    const escapedName = p.name.replace(/'/g, "''");
    const escapedDomain = p.domain.replace(/'/g, "''");
    // Atomic insert with duplicate prevention and effective approved roster assertion (Sol Round 24 P1-05)
    sqlStatements.push(
      `INSERT INTO projects (id, organization_id, name, domain, location_code, language_code, created_at)
       SELECT '${p.id}', '${orgId}', '${escapedName}', '${escapedDomain}', 2360, 'id', CURRENT_TIMESTAMP
       WHERE NOT EXISTS (
         SELECT 1 FROM projects
         WHERE organization_id = '${orgId}' AND lower(trim(domain)) = '${escapedDomain}' AND archived_at IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM fleet_roster_members rm
         JOIN fleet_roster_versions v ON v.id = rm.version_id
         WHERE v.id = '${approvedRoster.id}'
           AND v.organization_id = '${orgId}'
           AND rm.canonical_host = '${escapedDomain}'
           AND rm.enrollment_state = 'active'
           AND v.id = (
             SELECT id FROM fleet_roster_versions
             WHERE organization_id = '${orgId}'
               AND approved_at IS NOT NULL
               AND julianday(approved_at) <= julianday('now')
             ORDER BY julianday(approved_at) DESC NULLS LAST, id COLLATE BINARY DESC
             LIMIT 1
           )
       );`,
    );
  }

  // Scoped UPDATE with live write-time effective version predicate and project resolution (Sol F06)
  for (const m of membersToLink) {
    sqlStatements.push(`
      UPDATE fleet_roster_members AS m
      SET project_id = (
        SELECT p.id FROM projects AS p
        WHERE p.organization_id = '${orgId}'
          AND p.archived_at IS NULL AND lower(trim(p.domain)) = m.canonical_host
      )
      WHERE m.id = '${m.memberId}'
        AND m.version_id = '${approvedRoster.id}'
        AND m.version_id = (
          SELECT id FROM fleet_roster_versions
          WHERE organization_id = '${orgId}'
            AND approved_at IS NOT NULL
            AND julianday(approved_at) <= julianday('now')
          ORDER BY julianday(approved_at) DESC NULLS LAST, id COLLATE BINARY DESC
          LIMIT 1
        )
        AND m.canonical_host = '${m.host.replace(/'/g, "''")}'
        AND m.project_id IS NULL
        AND 1 = (
          SELECT count(*) FROM projects AS p
          WHERE p.organization_id = '${orgId}'
            AND p.archived_at IS NULL AND lower(trim(p.domain)) = m.canonical_host
        )
      RETURNING id, project_id;
    `);
  }

  // Helper to perform strict live roster verification scoped to version and organization (Sol P1-01)
  function verifyRosterIntegrity(
    rosterId: string,
    orgId: string,
    expectedCount: number,
    isRemote: boolean,
  ) {
    const query = `
    SELECT
      COUNT(m.id) AS member_count,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.project_id IS NULL THEN 1 ELSE 0 END), 0) AS unmapped,
      COALESCE(SUM(CASE WHEN m.project_id IS NOT NULL AND (p.id IS NULL OR p.organization_id <> v.organization_id OR p.archived_at IS NOT NULL OR p.domain IS NULL OR lower(trim(p.domain)) <> m.canonical_host) THEN 1 ELSE 0 END), 0) AS invalid_links
    FROM fleet_roster_versions v
    LEFT JOIN fleet_roster_members m ON m.version_id = v.id
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE v.id = '${rosterId}' AND v.organization_id = '${orgId}'
    GROUP BY v.id;
  `;
    const res = runD1Query(query, isRemote);
    if (!res || res.length === 0) {
      throw new Error(
        `Roster integrity query returned no records for roster ${rosterId} in organization ${orgId}.`,
      );
    }
    const row = res[0];
    const memberCount = Number(row.member_count ?? 0);
    const unmapped = Number(row.unmapped ?? 0);
    const invalidLinks = Number(row.invalid_links ?? 0);

    if (memberCount !== expectedCount) {
      throw new Error(
        `Roster member count mismatch: expected ${expectedCount}, found ${memberCount} for roster ${rosterId}.`,
      );
    }
    if (unmapped > 0) {
      throw new Error(
        `${unmapped} fleet roster members remain unmapped in roster ${rosterId}.`,
      );
    }
    if (invalidLinks > 0) {
      throw new Error(
        `${invalidLinks} fleet roster members point to foreign, missing, or archived projects in roster ${rosterId}.`,
      );
    }
    console.log(
      `Live verification: 100% of fleet roster members (${memberCount}/${expectedCount}) are strictly mapped to active projects in organization ${orgId}!`,
    );
  }

  if (sqlStatements.length === 0) {
    if (!isDryRun) {
      const liveVersions = runD1Query(
        `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = '${orgId}';`,
        isRemote,
      );
      const currentEffective = selectEffectiveRosterVersion(liveVersions);
      if (currentEffective?.id !== approvedRoster.id) {
        throw new Error(
          `Effective roster version supersession detected on no-change path: was ${approvedRoster.id}, now ${currentEffective?.id ?? "none"}. Aborting.`,
        );
      }
      verifyRosterIntegrity(
        approvedRoster.id,
        orgId,
        approvedRoster.domain_count ?? existingMembers.length,
        isRemote,
      );
      console.log(
        `Live verification: All portfolio projects and fleet roster members in ${approvedRoster.id} are 100% mapped! Zero updates required.`,
      );
    } else {
      if (unmappedCount > 0) {
        console.error(
          `[ERROR] ${unmappedCount} fleet roster members remain unmapped.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `Dry run preview: All portfolio projects and fleet roster members are 100% mapped! Zero updates required.`,
      );
    }
    return;
  }

  console.log(`Executing ${sqlStatements.length} SQL statements against D1...`);
  executeD1SqlBatches(sqlStatements, isRemote);

  // 5. Re-check effective roster version post-apply to detect supersession (Sol F10)
  const postApprovedVersions = runD1Query(
    `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = '${orgId}';`,
    isRemote,
  );
  const postEffective = selectEffectiveRosterVersion(postApprovedVersions);
  if (!postEffective || postEffective.id !== approvedRoster.id) {
    throw new Error(
      `Roster superseded during linking: effective roster changed from ${approvedRoster.id} to ${postEffective?.id ?? "none"}.`,
    );
  }

  // 6. Verification check strictly scoped to current roster and organization (Sol P1-01, F5, F10)
  verifyRosterIntegrity(
    approvedRoster.id,
    orgId,
    approvedRoster.domain_count ?? existingMembers.length,
    isRemote,
  );
}

// CLI execution
if (process.argv[1] && process.argv[1].includes("link-github-fleet")) {
  const rawArgs = process.argv.slice(2);
  const hasRemote = rawArgs.includes("--remote");
  const hasLocal = rawArgs.includes("--local");
  if (hasRemote && hasLocal) {
    console.error(
      "[ERROR] Conflicting flags: cannot specify both --remote and --local.",
    );
    process.exit(1);
  }

  const { values } = parseArgs({
    args: rawArgs,
    options: {
      "dry-run": { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      "org-id": { type: "string", default: "shared-workspace" },
    },
  });

  const isRemote = hasRemote ? true : false;
  linkFleet({
    dryRun: values["dry-run"],
    remote: isRemote,
    orgId: values["org-id"],
  }).catch((err) => {
    console.error("Fleet linking failed:", err);
    process.exit(1);
  });
}
