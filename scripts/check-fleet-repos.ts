import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ENV_FILE = resolve("C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/.env.selfhost");
const FLEET_MANIFEST_FILE = resolve("src/server/features/fleet/data/fleetManifest.json");
const PROJECTS_GITHUB_FILE = resolve("C:/Users/THINKPAD/OneDrive/MD/PORTFOLIO/EVIDENCE/PROJECTS_GITHUB.md");

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
  } catch {}
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

const projects = runD1Query("SELECT id, name, domain FROM projects WHERE organization_id = 'shared-workspace' AND domain IS NOT NULL AND archived_at IS NULL;");
const audits = runD1Query("SELECT DISTINCT project_id FROM audits WHERE status = 'completed';");
const auditedProjectIds = new Set(audits.map(a => a.project_id));

// Load manifest
const manifest = JSON.parse(readFileSync(FLEET_MANIFEST_FILE, "utf8"));
const repoByDomain = new Map<string, string>();
for (const m of manifest) {
  if (m.canonicalHost && m.repoName) {
    repoByDomain.set(m.canonicalHost.toLowerCase().trim(), m.repoName.trim());
  }
}

// Load PROJECTS_GITHUB.md
const ghRaw = readFileSync(PROJECTS_GITHUB_FILE, "utf8");
for (const line of ghRaw.split(/\r?\n/)) {
  const match = line.match(/^\|\s*([^|]+)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*([^|]+)\|/);
  if (match) {
    const owner = match[1].trim();
    const repo = match[2].trim();
    const site = match[3].trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!repoByDomain.has(site)) {
      repoByDomain.set(site, `${owner}/${repo}`);
    }
  }
}

let auditedWithRepo = 0;
let unauditedWithRepo = 0;
const unauditedList: { domain: string; repo: string; id: string }[] = [];

for (const p of projects) {
  const dom = p.domain.toLowerCase().trim();
  const repo = repoByDomain.get(dom);
  if (repo) {
    if (auditedProjectIds.has(p.id)) {
      auditedWithRepo++;
    } else {
      unauditedWithRepo++;
      unauditedList.push({ domain: dom, repo, id: p.id });
    }
  }
}

console.log(`Audited with GitHub repo: ${auditedWithRepo}`);
console.log(`Unaudited with GitHub repo: ${unauditedWithRepo}`);
console.log(`Sample unaudited (10):`, unauditedList.slice(0, 10));
