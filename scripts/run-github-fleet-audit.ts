/**
 * Internal GitHub Repository Direct Audit Engine (`run-github-fleet-audit.ts`)
 *
 * Audits portfolio properties directly from their GitHub repositories using the
 * GitHub Git Database API, commit-pinned raw blob streaming, in-memory link graph
 * validation, and staged Cloudflare D1 persistence with atomic completion checks.
 *
 * Usage:
 *   pnpm exec tsx scripts/run-github-fleet-audit.ts [--domain <domain>] [--limit <n>] [--all] [--force]
 */
import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { parseArgs } from "node:util";
import {
  capBytes,
  streamToBuffer,
  verifyGitBlob,
  parseTarHtmlFiles,
  decompressGzipStream,
  isValidCanonicalHostname,
  isValidRepoSlug,
  discoverGitHubTree,
  resolveGitHubHead,
  fetchGitHubTree,
  type GitHubHeadDescriptor,
  sqlText,
  normalizeGitRelativePath,
  selectEffectiveRosterVersion,
  executeD1SqlBatches,
  acquireVerifiedBlob,
  type GitTreeItem,
} from "./github-archive-utils";
import { isSameOrigin } from "../src/server/lib/audit/url-utils";
import { analyzeHtml } from "../src/server/lib/audit/page-analyzer";
import {
  runPageReporters,
  type DetectedIssue,
} from "../src/server/lib/audit/issues/page-reporters";
import type { CrawledPageResult } from "../src/server/lib/audit/types";
import { deterministicAuditRowId } from "../src/server/lib/audit/ids";
import { getIssueDescriptor } from "../src/shared/audit-issues";

const ENV_FILE = resolve(".env.selfhost");
const FLEET_MANIFEST_FILE = resolve(
  "src/server/features/fleet/data/fleetManifest.json",
);
const PROJECTS_GITHUB_FILE = resolve(
  "C:/Users/THINKPAD/OneDrive/MD/PORTFOLIO/EVIDENCE/PROJECTS_GITHUB.md",
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
        const val = line
          .slice(eqIdx + 1)
          .trim()
          .replace(/^['"]|['"]$/g, "");
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

function getGitHubToken(): string {
  try {
    const token = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (token) return token;
  } catch {}
  return process.env.GITHUB_TOKEN || "";
}

const GITHUB_TOKEN = getGitHubToken();

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
  return executeD1SqlBatches([query], isRemote);
}

function executeD1SqlStatements(sqlLines: string[], isRemote = true): void {
  executeD1SqlBatches(sqlLines, isRemote);
}

interface RepoMapping {
  domain: string;
  repoName: string;
  projectId?: string;
  publishRoot?: string;
  expectedRosterVersionId?: string;
  expectedMemberId?: string;
}

function loadRepoMappings(): Map<string, RepoMapping> {
  const map = new Map<string, RepoMapping>();
  const ambiguousHosts = new Set<string>();

  // 1. Load from fleetManifest.json (canonical approved mappings take highest precedence)
  try {
    const raw = readFileSync(FLEET_MANIFEST_FILE, "utf8");
    const list = JSON.parse(raw);
    for (const item of list) {
      if (item.canonicalHost && item.repoName) {
        const host = item.canonicalHost.toLowerCase().trim();
        const repoSlug = item.repoName.trim();
        if (isValidRepoSlug(repoSlug)) {
          const normRoot = normalizeGitRelativePath(item.publishRoot ?? ".");
          const currentMapping = map.get(host);
          if (
            currentMapping &&
            (currentMapping.repoName !== repoSlug ||
              currentMapping.publishRoot !== normRoot)
          ) {
            console.warn(
              `[MANIFEST] Ambiguous conflicting repository/root mapping for '${host}': '${currentMapping.repoName}' (${currentMapping.publishRoot}) vs '${repoSlug}' (${normRoot}). Excluding ambiguous host.`,
            );
            ambiguousHosts.add(host);
          } else {
            map.set(host, {
              domain: host,
              repoName: repoSlug,
              publishRoot: normRoot,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("Could not load fleetManifest.json:", err);
  }

  // 2. Enrich unmapped hosts from PROJECTS_GITHUB.md
  try {
    const raw = readFileSync(PROJECTS_GITHUB_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
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
        const slug = `${owner}/${repo}`;
        if (owner && repo && site && isValidRepoSlug(slug)) {
          const normRoot = ".";
          const currentMapping = map.get(site);
          if (
            currentMapping &&
            (currentMapping.repoName !== slug ||
              currentMapping.publishRoot !== normRoot)
          ) {
            console.warn(
              `[MANIFEST] Ambiguous conflicting repository/root mapping for '${site}': '${currentMapping.repoName}' (${currentMapping.publishRoot}) vs '${slug}' (${normRoot}). Excluding ambiguous host.`,
            );
            ambiguousHosts.add(site);
          } else if (!map.has(site)) {
            map.set(site, {
              domain: site,
              repoName: slug,
              publishRoot: normRoot,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("Could not load PROJECTS_GITHUB.md:", err);
  }

  for (const ambiguous of ambiguousHosts) {
    map.delete(ambiguous);
  }

  return map;
}

const normalizeRoute = (urlOrPath: string): string => {
  let s = urlOrPath
    .split("#")[0]
    .split("?")[0]
    .replace(/^https?:\/\//, "");
  const slashIdx = s.indexOf("/");
  if (slashIdx === -1) {
    return s.toLowerCase();
  }
  const host = s.slice(0, slashIdx).toLowerCase();
  let path = s.slice(slashIdx);
  try {
    path = decodeURI(path);
  } catch {}
  path = path.replace(/\/+$/, "");
  return `${host}${path}`;
};

function boundIssueDetails(details: any, maxBytes = 3499): string | null {
  if (!details || typeof details !== "object") return null;

  try {
    const candidate = JSON.stringify(details);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      return candidate;
    }
  } catch {}

  let targetUrl =
    typeof details.targetUrl === "string" ? details.targetUrl : undefined;
  let message =
    typeof details.message === "string" ? details.message : undefined;

  if (message && message.length > 200) {
    message = message.slice(0, 200);
  }

  const fallback = JSON.stringify({
    ...details,
    targetUrl,
    message,
    _truncated: true,
  });
  if (Buffer.byteLength(fallback, "utf8") <= maxBytes) {
    return fallback;
  }

  // Progressively truncate targetUrl until valid JSON strictly fits within maxBytes
  if (targetUrl) {
    let curUrl = targetUrl.slice(0, 500);
    while (curUrl.length > 20) {
      const minimal = JSON.stringify({
        targetUrl: curUrl,
        message,
        _truncated: true,
      });
      if (Buffer.byteLength(minimal, "utf8") <= maxBytes) {
        return minimal;
      }
      curUrl = curUrl.slice(0, Math.floor(curUrl.length * 0.7));
    }
  }

  const marker = JSON.stringify({ _truncated: true });
  if (Buffer.byteLength(marker, "utf8") <= maxBytes) {
    return marker;
  }
  return null;
}

export interface CompletedAuditMatch {
  id: string;
  hasDiagnostic: boolean;
}

export type RosterSource = Readonly<{
  versionId: string;
  memberId: string;
  projectId: string;
  canonicalHost: string;
  repoName: string;
  publishRoot: string;
}>;

export function findMatchingCompletedAudit(
  projectId: string,
  repoName: string,
  publishRoot: string,
  commitSha: string,
  rosterSourceOrVersionId?: RosterSource | string | null,
  isRemote = true,
): CompletedAuditMatch | null {
  const normalizedRoot = normalizeGitRelativePath(publishRoot || ".");
  const rosterSource: RosterSource | null =
    typeof rosterSourceOrVersionId === "object" &&
    rosterSourceOrVersionId !== null
      ? rosterSourceOrVersionId
      : null;
  const effectiveRosterId =
    rosterSource?.versionId ??
    (typeof rosterSourceOrVersionId === "string"
      ? rosterSourceOrVersionId
      : null);

  const rosterSourceSql = rosterSource
    ? `AND json_valid(a.config)
       AND json_extract(a.config, '$.rosterSource.versionId') = ${sqlText(rosterSource.versionId)}
       AND json_extract(a.config, '$.rosterSource.memberId') = ${sqlText(rosterSource.memberId)}
       AND json_extract(a.config, '$.rosterSource.projectId') = ${sqlText(rosterSource.projectId)}
       AND lower(trim(json_extract(a.config, '$.rosterSource.canonicalHost'))) = lower(trim(${sqlText(rosterSource.canonicalHost)}))
       AND json_extract(a.config, '$.rosterSource.repoName') = ${sqlText(rosterSource.repoName)}
       AND json_type(a.config, '$.rosterSource.publishRoot') = 'text'
       AND json_extract(a.config, '$.rosterSource.publishRoot') = ${sqlText(normalizedRoot)}`
    : effectiveRosterId
      ? `AND json_valid(a.config) AND json_extract(a.config, '$.rosterSource.versionId') = ${sqlText(effectiveRosterId)}`
      : "";

  const tripleFilter = rosterSource
    ? `AND r.roster_version_id = ${sqlText(rosterSource.versionId)}
       AND rm.version_id = ${sqlText(rosterSource.versionId)}
       AND rm.id = ${sqlText(rosterSource.memberId)}
       AND lower(trim(rm.canonical_host)) = lower(trim(${sqlText(rosterSource.canonicalHost)}))`
    : effectiveRosterId
      ? `AND r.roster_version_id = ${sqlText(effectiveRosterId)} AND rm.version_id = ${sqlText(effectiveRosterId)}`
      : "";

  const rows = runD1Query(
    `SELECT a.id, a.config,
            (
              SELECT COUNT(*)
              FROM fleet_runs r
              JOIN fleet_run_items fri ON fri.run_id = r.id
              JOIN fleet_snapshots fs ON fs.run_item_id = fri.id
              JOIN fleet_roster_members rm ON fri.member_id = rm.id
              WHERE fri.audit_id = a.id
                AND fri.primary_series_key = 'diagnostic'
                AND fs.series_key = 'diagnostic'
                AND r.status = 'completed'
                AND fri.status = 'completed'
                AND fri.project_id = a.project_id
                AND fs.project_id = a.project_id
                AND fs.member_id = fri.member_id
                AND rm.project_id = a.project_id
                AND fs.canonical_host = rm.canonical_host
                AND r.organization_id = 'shared-workspace'
                ${tripleFilter}
            ) AS has_verified_triple
     FROM audits a
     WHERE a.project_id = ${sqlText(projectId)}
       AND a.status = 'completed'
       AND a.workflow_instance_id LIKE 'github-audit-%'
       AND a.pages_total > 0
       AND a.pages_crawled >= a.pages_total
       AND json_extract(a.config, '$.source') = 'github_repository_direct'
       AND json_extract(a.config, '$.commitSha') = ${sqlText(commitSha)}
       AND json_extract(a.config, '$.repoName') = ${sqlText(repoName)}
       AND coalesce(json_extract(a.config, '$.publishRoot'), '.') = ${sqlText(normalizedRoot)}
       ${rosterSourceSql}
     ORDER BY julianday(a.completed_at) DESC NULLS LAST, a.id DESC
     LIMIT 1;`,
    isRemote,
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  try {
    const cfg = JSON.parse(row.config);
    if (
      cfg.source !== "github_repository_direct" ||
      cfg.repoName !== repoName ||
      normalizeGitRelativePath(cfg.publishRoot ?? ".") !== normalizedRoot ||
      cfg.commitSha !== commitSha
    ) {
      return null;
    }
    if (rosterSource) {
      if (!cfg.rosterSource) return null;
      const rs = cfg.rosterSource;
      if (
        rs.versionId !== rosterSource.versionId ||
        rs.memberId !== rosterSource.memberId ||
        rs.projectId !== rosterSource.projectId ||
        rs.canonicalHost?.toLowerCase().trim() !==
          rosterSource.canonicalHost.toLowerCase().trim() ||
        rs.repoName !== rosterSource.repoName ||
        normalizeGitRelativePath(rs.publishRoot ?? ".") !== normalizedRoot
      ) {
        return null;
      }
    } else if (
      effectiveRosterId &&
      cfg.rosterSource?.versionId &&
      cfg.rosterSource.versionId !== effectiveRosterId
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    id: row.id,
    hasDiagnostic: Number(row.has_verified_triple ?? 0) === 1,
  };
}

function bareHost(host: string): string {
  return host
    .toLowerCase()
    .trim()
    .replace(/^www\./, "");
}

function isAdmissibleInternalLink(
  targetUrl: string,
  canonicalHost: string,
): boolean {
  try {
    const target = new URL(targetUrl);
    const defaultWebPort =
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.port === "";
    return (
      defaultWebPort && bareHost(target.hostname) === bareHost(canonicalHost)
    );
  } catch {
    return false;
  }
}

async function auditRepository(
  mapping: RepoMapping,
  head: GitHubHeadDescriptor,
  treeItems: GitTreeItem[],
  maxPages = 10000,
  useArchive = false,
  isRemote = true,
): Promise<boolean> {
  const { domain, repoName, projectId } = mapping;
  if (!projectId) {
    throw new Error(
      `Cannot audit repository '${repoName}' for domain '${domain}': missing projectId`,
    );
  }
  console.log(`\n======================================================`);
  console.log(`Auditing ${domain} directly from GitHub repo ${repoName}`);
  console.log(`======================================================`);

  const defaultBranch = head.branch;
  const commitSha = head.commitSha;
  const isTreeTruncated = false;
  console.log(
    `Pinned commit: ${commitSha.slice(0, 10)} (branch: ${defaultBranch}, tree: ${head.treeSha.slice(0, 10)})`,
  );

  // 2. Build comprehensive unified route index with collision detection & served identity admission (Sol F01, F02)
  const publishRoot = mapping.publishRoot ?? ".";
  const prefix =
    publishRoot === "." ? "" : publishRoot.replace(/^\/+|\/+$/g, "") + "/";

  // Helper to map repo path to public page URL using canonical served identities (Sol Snippet 3, F01)
  const pathToUrl = (path: string): string => {
    const relativePath =
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const segments = relativePath.split("/").map(encodeURIComponent);
    const isDirectoryIndex = /^(?:index\.html|index\.htm)$/i.test(
      segments.at(-1) ?? "",
    );
    if (isDirectoryIndex) segments.pop();
    const pathname =
      "/" +
      segments.join("/") +
      (isDirectoryIndex && segments.length ? "/" : "");
    return `https://${domain}${pathname}`;
  };

  // Group candidate HTML files by served page URL to detect index collisions (.html vs .htm)
  const htmlBlobsByServedUrl = new Map<string, GitTreeItem[]>();
  const ambiguousServedUrls = new Set<string>();

  type RouteOwner =
    | { kind: "page"; gitPath: string; pageUrl: string }
    | { kind: "asset"; gitPath: string }
    | { kind: "ambiguous"; gitPaths: string[] };

  const physicalRoutes = new Map<string, RouteOwner>();
  const aliases = new Map<string, Map<string, RouteOwner>>();

  function addAlias(route: string, owner: RouteOwner) {
    const owners = aliases.get(route) ?? new Map<string, RouteOwner>();
    const key =
      owner.kind === "ambiguous" ? owner.gitPaths.join(",") : owner.gitPath;
    owners.set(key, owner);
    aliases.set(route, owners);
  }

  function resolveRoute(route: string) {
    const exact = physicalRoutes.get(route);
    if (exact) return { kind: "known" as const, owner: exact };
    const candidates = [...(aliases.get(route)?.values() ?? [])];
    if (candidates.length === 1)
      return { kind: "known" as const, owner: candidates[0] };
    if (candidates.length > 1)
      return { kind: "ambiguous" as const, candidates };
    return { kind: "missing" as const };
  }

  for (const item of treeItems) {
    if (
      item.type !== "blob" ||
      (item.mode !== "100644" && item.mode !== "100755")
    )
      continue;
    const p = item.path;
    // Sol F01: filter by declared publish root boundary
    if (prefix && !p.startsWith(prefix)) continue;
    const isHtml = p.endsWith(".html") || p.endsWith(".htm");

    if (isHtml) {
      const served = pathToUrl(p);
      const list = htmlBlobsByServedUrl.get(served) ?? [];
      list.push(item);
      htmlBlobsByServedUrl.set(served, list);
    } else {
      // Register static asset physical route
      const servedPath = prefix ? p.slice(prefix.length) : p;
      const encodedPath = servedPath
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const physicalRoute = normalizeRoute(`${domain}/${encodedPath}`);
      physicalRoutes.set(physicalRoute, { kind: "asset", gitPath: p });
    }
  }

  // Admit unique served identities: if both index.html and index.htm exist, prefer .html and flag ambiguous
  const htmlFiles: GitTreeItem[] = [];
  for (const [servedUrl, items] of htmlBlobsByServedUrl.entries()) {
    if (items.length === 1) {
      htmlFiles.push(items[0]);
    } else {
      ambiguousServedUrls.add(servedUrl);
      const htmlExt = items.find((it) => it.path.endsWith(".html"));
      const chosen = htmlExt ?? items[0];
      htmlFiles.push(chosen);
    }
  }

  // Sort HTML candidate files by path for deterministic audit order
  htmlFiles.sort((a, b) => a.path.localeCompare(b.path));

  // Register physical and clean alias routes for admitted HTML files (Sol F02)
  for (const file of htmlFiles) {
    const p = file.path;
    const servedPath = prefix ? p.slice(prefix.length) : p;
    const encodedPath = servedPath.split("/").map(encodeURIComponent).join("/");
    const pageUrl = pathToUrl(p);
    const physicalKey = normalizeRoute(`${domain}/${encodedPath}`);

    if (ambiguousServedUrls.has(pageUrl)) {
      const allItems = htmlBlobsByServedUrl.get(pageUrl) ?? [file];
      const allPaths = allItems.map((it) => it.path);
      const ambigOwner: RouteOwner = { kind: "ambiguous", gitPaths: allPaths };
      for (const item of allItems) {
        const itemServedPath = prefix
          ? item.path.slice(prefix.length)
          : item.path;
        const itemEncoded = itemServedPath
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        physicalRoutes.set(
          normalizeRoute(`${domain}/${itemEncoded}`),
          ambigOwner,
        );
      }
      addAlias(normalizeRoute(pageUrl), ambigOwner);
    } else {
      const pageOwner: RouteOwner = { kind: "page", gitPath: p, pageUrl };
      physicalRoutes.set(physicalKey, pageOwner);

      // Inferred aliases: extensionless & directory roots
      let cleanSlug: string | null = null;
      if (servedPath === "index.html" || servedPath === "index.htm") {
        cleanSlug = "";
      } else if (servedPath.endsWith("/index.html")) {
        cleanSlug = encodedPath.slice(0, -11);
      } else if (servedPath.endsWith("/index.htm")) {
        cleanSlug = encodedPath.slice(0, -10);
      } else if (servedPath.endsWith(".html")) {
        cleanSlug = encodedPath.slice(0, -5);
      } else if (servedPath.endsWith(".htm")) {
        cleanSlug = encodedPath.slice(0, -4);
      }

      if (cleanSlug !== null) {
        const cleanRoute =
          cleanSlug === ""
            ? normalizeRoute(domain)
            : normalizeRoute(`${domain}/${cleanSlug}`);
        addAlias(cleanRoute, pageOwner);
        const cleanSlashRoute =
          cleanSlug === ""
            ? normalizeRoute(`${domain}/`)
            : normalizeRoute(`${domain}/${cleanSlug}/`);
        addAlias(cleanSlashRoute, pageOwner);
      }
    }
  }

  console.log(
    `Discovered ${htmlFiles.length} unique static HTML pages (${ambiguousServedUrls.size} ambiguous index collisions resolved) and ${treeItems.length} total repository assets in ${repoName}`,
  );
  if (htmlFiles.length === 0) {
    console.warn(`No HTML pages found in repository ${repoName}. Skipping.`);
    return false;
  }

  const candidateFiles = htmlFiles.slice(0, maxPages);

  // Build alias-to-canonical URL map for fast lookup
  const aliasToCanonicalUrl = new Map<string, string>();
  for (const file of htmlFiles) {
    const pageUrl = pathToUrl(file.path);
    const encoded = file.path.split("/").map(encodeURIComponent).join("/");
    aliasToCanonicalUrl.set(normalizeRoute(pageUrl), pageUrl);
    aliasToCanonicalUrl.set(normalizeRoute(`${domain}/${encoded}`), pageUrl);
    aliasToCanonicalUrl.set(normalizeRoute(`/${encoded}`), pageUrl);
  }

  // Handle stale recovery (> 2 hours old without completion) strictly for repository-lane audits (Sol R3)
  executeD1SqlStatements(
    [
      `UPDATE audits SET status = 'failed', current_phase = 'failed', failed_phase = CASE WHEN current_phase IS NOT NULL AND current_phase != 'failed' THEN current_phase ELSE 'analyzing' END, error_code = 'runner_timeout', completed_at = CURRENT_TIMESTAMP WHERE project_id = ${sqlText(projectId)} AND status = 'running' AND workflow_instance_id LIKE 'github-audit-%' AND (julianday('now') - julianday(started_at)) * 24 >= 2;`,
    ],
    isRemote,
  );

  // Sol P1-01, P2-07: Generate unique attempt ID (v4 UUID) and reserve row before acquiring blobs or archive
  const auditId = crypto.randomUUID();
  const startTime = Date.now();
  const startedAtIso = new Date().toISOString();

  const configJson = JSON.stringify({
    source: "github_repository_direct",
    configVersion: 2,
    repoName,
    branch: defaultBranch,
    commitSha,
    treeSha: head.treeSha,
    publishRoot: mapping.publishRoot ?? ".",
    maxPages,
    totalFiles: htmlFiles.length,
    treeTruncated: isTreeTruncated,
    rosterSource:
      mapping.expectedRosterVersionId && mapping.expectedMemberId
        ? {
            versionId: mapping.expectedRosterVersionId,
            memberId: mapping.expectedMemberId,
            projectId,
            canonicalHost: domain,
            repoName,
            publishRoot: normalizeGitRelativePath(mapping.publishRoot ?? "."),
          }
        : null,
  });

  // Reserve audit attempt in D1 conditionally — fails atomically if an active running repository audit already exists
  executeD1SqlStatements(
    [
      `INSERT INTO audits (
      id, project_id, started_by_user_id, start_url,
      workflow_instance_id, config, status, pages_crawled,
      pages_total, lighthouse_total, current_phase, started_at
    )
    SELECT
      ${sqlText(auditId)}, ${sqlText(projectId)}, 'system', ${sqlText(`https://${domain}`)},
      ${sqlText(`github-audit-${auditId}`)}, ${sqlText(configJson)}, 'running', 0,
      ${htmlFiles.length}, 0, 'analyzing', ${sqlText(startedAtIso)}
    WHERE NOT EXISTS (
      SELECT 1 FROM audits
      WHERE project_id = ${sqlText(projectId)} AND status = 'running'
    );`,
    ],
    isRemote,
  );

  const reserved = runD1Query(
    `SELECT id FROM audits WHERE id = ${sqlText(auditId)};`,
    isRemote,
  );
  if (reserved.length === 0) {
    console.warn(
      `[CONFLICT] Project ${projectId} already has an active running audit or was reserved by another runner. Skipping concurrent execution.`,
    );
    return false;
  }

  // 3. Fetch and analyze HTML files with paced concurrency
  const crawledPages: CrawledPageResult[] = [];
  const detectedIssues: DetectedIssue[] = [];
  const inboundLinkCounts = new Map<string, number>();
  let hasTruncatedLinks = false;

  let archiveHtmlMap: Map<string, Buffer> | null = null;
  if (useArchive) {
    try {
      console.log(
        `[ARCHIVE] In-process streaming commit-pinned tarball for ${repoName} (${commitSha.slice(0, 10)})...`,
      );
      const tarUrl = `https://codeload.github.com/${repoName}/legacy.tar.gz/${commitSha}`;
      const res = await fetch(tarUrl, {
        headers: {
          ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
          "User-Agent": "OpenSEO-Audit",
          "Accept-Encoding": "identity",
        },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching archive from codeload`);
      }
      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 100 * 1024 * 1024) {
        throw new Error(`Archive exceeds 100MB bound (${contentLength} bytes)`);
      }
      if (!res.body) {
        throw new Error("Empty archive response body");
      }
      const tarStream = res.body
        .pipeThrough(capBytes(100 * 1024 * 1024, "compressed archive"))
        .pipeThrough(decompressGzipStream())
        .pipeThrough(capBytes(250 * 1024 * 1024, "expanded archive"));
      const decompressed = await streamToBuffer(tarStream);
      archiveHtmlMap = parseTarHtmlFiles(decompressed);
      console.log(
        `[ARCHIVE] Extracted ${archiveHtmlMap.size} HTML files from archive in memory.`,
      );
    } catch (err: any) {
      console.warn(
        `[WARN] Tarball archive streaming failed (${err?.message || err}), falling back to concurrent blob fetching.`,
      );
      archiveHtmlMap = null;
    }
  }

  const CONCURRENCY = 25;
  for (let i = 0; i < candidateFiles.length; i += CONCURRENCY) {
    const slice = candidateFiles.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (file) => {
        const pageUrl = pathToUrl(file.path);
        try {
          // Sol F8: Acquire blob using shared verified acquisition with raw fallback
          const { buffer: bytes } = await acquireVerifiedBlob(
            file,
            repoName,
            commitSha,
            archiveHtmlMap,
            GITHUB_TOKEN,
          );

          const html = bytes.toString("utf8");
          const analysis = analyzeHtml(html, pageUrl, 200, 50);
          if (analysis.truncatedLinks) {
            hasTruncatedLinks = true;
          }

          const pageId = await deterministicAuditRowId(auditId, pageUrl);
          const contentHash = analysis.bodyText
            ? crypto
                .createHash("sha256")
                .update(analysis.bodyText)
                .digest("hex")
            : null;
          const pageResult: CrawledPageResult = {
            id: pageId,
            url: pageUrl,
            statusCode: 200,
            fetchClass: "ok",
            redirectUrl: null,
            responseTimeMs: 50,
            title: analysis.title || "",
            metaDescription: analysis.metaDescription || "",
            canonicalUrl: analysis.canonical,
            robotsMeta: analysis.robotsMeta,
            xRobotsTag: null,
            headerCanonicalUrl: null,
            ogTitle: analysis.ogTitle,
            ogDescription: analysis.ogDescription,
            ogImage: analysis.ogImage,
            h1Count: analysis.headingOrder.filter((h) => h === 1).length,
            h2Count: analysis.headingOrder.filter((h) => h === 2).length,
            h3Count: analysis.headingOrder.filter((h) => h === 3).length,
            h4Count: analysis.headingOrder.filter((h) => h === 4).length,
            h5Count: analysis.headingOrder.filter((h) => h === 5).length,
            h6Count: analysis.headingOrder.filter((h) => h === 6).length,
            headingOrder: analysis.headingOrder,
            wordCount: analysis.wordCount,
            contentHash,
            isHtml: true,
            htmlBytes: Buffer.byteLength(html, "utf8"),
            rateLimited: false,
            imagesTotal: analysis.images.length,
            imagesMissingAlt: analysis.images.filter(
              (img) => !img.alt || img.alt.trim() === "",
            ).length,
            images: analysis.images,
            links: analysis.links.map((l) => ({
              ...l,
              isInternal: isAdmissibleInternalLink(l.targetUrl, domain),
            })),
            hreflangTags: analysis.hreflangTags,
            hasStructuredData: analysis.hasStructuredData,
            isIndexable: !analysis.robotsMeta
              ?.toLowerCase()
              .includes("noindex"),
            javascriptShell: analysis.javascriptShell,
            crawlDepth: 0,
            inSitemap: false,
          };

          crawledPages.push(pageResult);

          // Page-level issues (filter out unmeasured runtime-only issues e.g. deep-page)
          const issues = runPageReporters(pageResult).filter(
            (iss) => (iss.issueType as string) !== "deep-page",
          );
          detectedIssues.push(...issues);

          // Check internal links using unified route owner index and apex/www equivalence (Sol F02, A3)
          for (const link of pageResult.links) {
            if (link.targetUrl && link.isInternal) {
              try {
                const target = new URL(link.targetUrl);
                const normTarget = normalizeRoute(
                  `https://${domain}${target.pathname}`,
                );
                const res = resolveRoute(normTarget);
                if (res.kind === "known") {
                  const owner = res.owner;
                  if (owner.kind === "page") {
                    if (owner.pageUrl !== pageUrl) {
                      inboundLinkCounts.set(
                        owner.pageUrl,
                        (inboundLinkCounts.get(owner.pageUrl) || 0) + 1,
                      );
                    }
                  }
                } else if (res.kind === "ambiguous") {
                  // Credit inbound edge to possible candidates so neither is falsely orphaned
                  for (const cand of res.candidates) {
                    if (cand.kind === "page" && cand.pageUrl !== pageUrl) {
                      inboundLinkCounts.set(
                        cand.pageUrl,
                        (inboundLinkCounts.get(cand.pageUrl) || 0) + 1,
                      );
                    }
                  }
                } else if (
                  !isTreeTruncated &&
                  candidateFiles.length === htmlFiles.length
                ) {
                  // Internal dead link confirmed only when tree is complete
                  detectedIssues.push({
                    issueType: "broken-internal-link",
                    pageId,
                    pageUrl,
                    dedupeKey: link.targetUrl,
                    details: { targetUrl: link.targetUrl },
                  });
                }
              } catch {}
            }
          }
        } catch (fetchErr: any) {
          console.warn(
            `Error analyzing ${file.path}:`,
            fetchErr?.message || fetchErr,
          );
        }
      }),
    );
    process.stdout.write(
      `\rProgress: ${Math.min(i + CONCURRENCY, candidateFiles.length)} / ${candidateFiles.length} pages analyzed`,
    );
  }
  console.log("\nPage analysis completed.");

  const attemptedCount = candidateFiles.length;
  const processedCount = crawledPages.length;
  const unreadCount = attemptedCount - processedCount;
  const isComplete =
    !isTreeTruncated &&
    candidateFiles.length === htmlFiles.length &&
    unreadCount === 0 &&
    processedCount > 0;
  const finalStatus = isComplete ? "completed" : "failed";

  // 4. Detect Orphan Pages (only when tree is complete, all eligible pages read, link graph untruncated, and no unrendered shells — Sol P1-03, P2-03, A3)
  const homeNorm = normalizeRoute(domain);
  const hasUnrenderedShells = crawledPages.some(
    (page) => page.javascriptShell === true,
  );
  if (isComplete && unreadCount === 0) {
    if (hasTruncatedLinks) {
      console.warn(
        `[WARN] Links were truncated on one or more pages (>1,000 links); orphan page detection suppressed to prevent false orphan reports.`,
      );
    } else if (hasUnrenderedShells) {
      console.warn(
        `[WARN] Unrendered JavaScript app shell detected; orphan page detection suppressed to prevent false orphan reports.`,
      );
    } else {
      for (const page of crawledPages) {
        if (normalizeRoute(page.url) === homeNorm) continue;
        if (ambiguousServedUrls.has(page.url)) {
          // Sol F1: Conflicting index paths (.html vs .htm) admit no orphan conclusion
          continue;
        }
        const inlinks =
          inboundLinkCounts.get(page.url) ||
          inboundLinkCounts.get(normalizeRoute(page.url)) ||
          0;
        if (inlinks === 0) {
          detectedIssues.push({
            issueType: "orphan-page",
            pageId: page.id,
            pageUrl: page.url,
            dedupeKey: `orphan:${page.url}`,
          });
        }
      }
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(
    `Analyzed ${processedCount}/${attemptedCount} pages (${unreadCount} unread, treeTruncated: ${isTreeTruncated}), detected ${detectedIssues.length} issues in ${durationSec}s.`,
  );
  console.log(`Final evaluation status: ${finalStatus}`);

  // 5. Staged Ingestion into Cloudflare D1
  console.log("Staging audit records into Cloudflare D1...");

  try {
    // Stage 1: Verify reserved parent audit is active before child writes (Sol P1-01)
    console.log(
      `[STAGE 1] Ingesting child evidence into reserved audit ${auditId}...`,
    );

    const boundUtf8Bytes = (
      s: string | null | undefined,
      maxBytes: number,
      maxChars?: number,
    ): string | null => {
      if (!s) return null;
      let trimmed = s.trim();
      if (!trimmed) return null;
      if (maxChars && trimmed.length > maxChars) {
        trimmed = trimmed.slice(0, maxChars);
      }
      if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) {
        return trimmed;
      }
      let acc = "";
      for (const char of trimmed) {
        if (Buffer.byteLength(acc + char, "utf8") > maxBytes) break;
        acc += char;
      }
      return acc || null;
    };

    function buildPageSql(
      p: CrawledPageResult,
      targetAuditId: string,
      limits: {
        titleBytes: number;
        descBytes: number;
        ogTitleBytes: number;
        ogDescBytes: number;
        canonicalBytes: number;
        ogImageBytes: number;
      },
    ): string {
      const title = boundUtf8Bytes(p.title, limits.titleBytes, 500);
      const metaDesc = boundUtf8Bytes(
        p.metaDescription,
        limits.descBytes,
        1000,
      );
      const canonical =
        limits.canonicalBytes > 0
          ? boundUtf8Bytes(p.canonicalUrl, limits.canonicalBytes, 2000)
          : null;
      const robots = boundUtf8Bytes(p.robotsMeta, 200, 200);
      const ogTitle = boundUtf8Bytes(p.ogTitle, limits.ogTitleBytes, 500);
      const ogDesc = boundUtf8Bytes(p.ogDescription, limits.ogDescBytes, 1000);
      const ogImage =
        limits.ogImageBytes > 0
          ? boundUtf8Bytes(p.ogImage, limits.ogImageBytes, 2000)
          : null;

      return `
        INSERT INTO audit_pages (
          id, audit_id, url, status_code, fetch_class, title, meta_description,
          canonical_url, robots_meta, og_title, og_description, og_image,
          h1_count, h2_count, h3_count, h4_count, h5_count, h6_count,
          word_count, content_hash, images_total, images_missing_alt, internal_link_count,
          external_link_count, has_structured_data, is_indexable, crawl_depth, in_sitemap, response_time_ms
        )
        SELECT
          ${sqlText(p.id)}, ${sqlText(targetAuditId)}, ${sqlText(p.url)}, NULL, ${sqlText(p.fetchClass)},
          ${sqlText(title)}, ${sqlText(metaDesc)}, ${sqlText(canonical)}, ${sqlText(robots)},
          ${sqlText(ogTitle)}, ${sqlText(ogDesc)}, ${sqlText(ogImage)},
          ${p.h1Count}, ${p.h2Count}, ${p.h3Count}, ${p.h4Count}, ${p.h5Count}, ${p.h6Count},
          ${p.wordCount}, ${sqlText(p.contentHash)}, ${p.imagesTotal}, ${p.imagesMissingAlt},
          ${p.links.filter((l) => l.isInternal).length}, ${p.links.filter((l) => !l.isInternal).length},
          ${p.hasStructuredData ? 1 : 0}, ${p.isIndexable ? 1 : 0}, NULL, 0, NULL
        WHERE EXISTS (SELECT 1 FROM audits WHERE id = ${sqlText(targetAuditId)} AND status = 'running')
        ON CONFLICT(id) DO NOTHING;
      `.trim();
    }

    // Stage 2: Insert audit pages with guarded parent check and bounded serialized byte budget (Sol A2, A4)
    const pageSqlLines: string[] = [];
    for (const p of crawledPages) {
      let limits = {
        titleBytes: 600,
        descBytes: 1200,
        ogTitleBytes: 600,
        ogDescBytes: 1200,
        canonicalBytes: 1200,
        ogImageBytes: 1000,
      };
      let stmt = buildPageSql(p, auditId, limits);
      const MAX_PAGE_SQL_BYTES = 10_000;
      // If statement or its JSON-serialized envelope exceeds budget, progressively scale down display/optional fields
      if (
        Buffer.byteLength(stmt, "utf8") > MAX_PAGE_SQL_BYTES ||
        Buffer.byteLength(JSON.stringify({ sql: stmt }), "utf8") >
          MAX_PAGE_SQL_BYTES
      ) {
        // Step 1: drop optional ogImage and shrink ogDesc/ogTitle
        limits = {
          ...limits,
          ogImageBytes: 0,
          ogDescBytes: 400,
          ogTitleBytes: 300,
        };
        stmt = buildPageSql(p, auditId, limits);
      }
      if (
        Buffer.byteLength(stmt, "utf8") > MAX_PAGE_SQL_BYTES ||
        Buffer.byteLength(JSON.stringify({ sql: stmt }), "utf8") >
          MAX_PAGE_SQL_BYTES
      ) {
        // Step 2: drop optional canonicalUrl and shrink metaDesc/title
        limits = {
          ...limits,
          canonicalBytes: 0,
          descBytes: 500,
          titleBytes: 300,
        };
        stmt = buildPageSql(p, auditId, limits);
      }
      if (
        Buffer.byteLength(stmt, "utf8") > MAX_PAGE_SQL_BYTES ||
        Buffer.byteLength(JSON.stringify({ sql: stmt }), "utf8") >
          MAX_PAGE_SQL_BYTES
      ) {
        // Step 3: aggressive clamp to minimal display lengths
        limits = {
          titleBytes: 150,
          descBytes: 200,
          ogTitleBytes: 100,
          ogDescBytes: 100,
          canonicalBytes: 0,
          ogImageBytes: 0,
        };
        stmt = buildPageSql(p, auditId, limits);
      }

      const finalBytes = Buffer.byteLength(stmt, "utf8");
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({ sql: stmt }),
        "utf8",
      );
      if (finalBytes > MAX_PAGE_SQL_BYTES || envelopeBytes > 14_999) {
        throw new Error(
          `Page SQL statement for ${p.url} exceeds strict serialized budget (${finalBytes} raw bytes, ${envelopeBytes} envelope bytes). Ingestion halted.`,
        );
      }
      pageSqlLines.push(stmt);
    }
    if (pageSqlLines.length > 0) {
      executeD1SqlStatements(pageSqlLines, isRemote);
    }

    // Stage 3: Insert audit issues guarded by parent attempt and page relationship (Sol V1-03, V1-06, A4)
    const issueSqlLines: string[] = [];
    for (const issue of detectedIssues) {
      const issueId = await deterministicAuditRowId(
        auditId,
        issue.pageUrl,
        issue.issueType,
        issue.dedupeKey ?? "",
      );
      const severity = getIssueDescriptor(issue.issueType)?.severity || "info";
      const boundedDetails = boundIssueDetails(issue.details, 3499);
      issueSqlLines.push(`
        INSERT INTO audit_issues (
          id, audit_id, issue_type, severity, page_id, page_url, details_json
        )
        SELECT
          ${sqlText(issueId)}, ${sqlText(auditId)}, ${sqlText(issue.issueType)}, ${sqlText(severity)}, ${issue.pageId ? sqlText(issue.pageId) : "NULL"},
          ${sqlText(issue.pageUrl)}, ${sqlText(boundedDetails)}
        WHERE EXISTS (SELECT 1 FROM audits WHERE id = ${sqlText(auditId)} AND status = 'running')
          AND (${issue.pageId ? `EXISTS (SELECT 1 FROM audit_pages WHERE id = ${sqlText(issue.pageId)} AND audit_id = ${sqlText(auditId)})` : "1=1"})
        ON CONFLICT(id) DO NOTHING;
      `);
    }
    if (issueSqlLines.length > 0) {
      executeD1SqlStatements(issueSqlLines, isRemote);
    }

    // Pre-CAS: Verify child row count integrity and ensure zero orphaned page references (Sol V1-03)
    const integrity = runD1Query(
      `SELECT
         (SELECT COUNT(*) FROM audit_pages WHERE audit_id = ${sqlText(auditId)}) AS pages,
         (SELECT COUNT(*) FROM audit_issues WHERE audit_id = ${sqlText(auditId)}) AS issues,
         (SELECT COUNT(*) FROM audit_issues ai LEFT JOIN audit_pages ap ON ai.page_id = ap.id AND ap.audit_id = ${sqlText(auditId)} WHERE ai.audit_id = ${sqlText(auditId)} AND ai.page_id IS NOT NULL AND ap.id IS NULL) AS invalid_refs;`,
      isRemote,
    );
    const actualPages = Number(integrity[0]?.pages ?? 0);
    const actualIssues = Number(integrity[0]?.issues ?? 0);
    const invalidRefs = Number(integrity[0]?.invalid_refs ?? 0);

    if (
      invalidRefs > 0 ||
      actualPages !== crawledPages.length ||
      actualIssues !== detectedIssues.length
    ) {
      throw new Error(
        `Audit child integrity verification failed for ${auditId}: pages=${actualPages}/${crawledPages.length}, issues=${actualIssues}/${detectedIssues.length}, invalid_page_refs=${invalidRefs}`,
      );
    }

    // Stage 4: Atomic compare-and-set flip to final status with child row count reconciliation, error code attribution, and RETURNING assertion (Sol P1-01, P1-05, Round 21 F10)
    const errorCode = !isComplete
      ? attemptedCount < htmlFiles.length
        ? "PAGE_BUDGET_REACHED"
        : unreadCount > 0
          ? "REPOSITORY_BLOB_UNREAD"
          : isTreeTruncated
            ? "TREE_TRUNCATED"
            : "INCOMPLETE_INGESTION"
      : null;
    const errorDetail = errorCode
      ? `Audit incomplete: ${errorCode} (processed ${processedCount} of ${htmlFiles.length} pages)`
      : null;

    const casSql = `UPDATE audits
       SET status = ${sqlText(finalStatus)},
           current_phase = ${sqlText(finalStatus)},
           pages_crawled = ${processedCount},
           pages_total = ${htmlFiles.length},
           error_code = ${errorCode ? sqlText(errorCode) : "NULL"},
           error_detail = ${errorDetail ? sqlText(errorDetail) : "NULL"},
           completed_at = datetime('now')
       WHERE id = ${sqlText(auditId)}
         AND status = 'running'
         AND (SELECT COUNT(*) FROM audit_pages WHERE audit_id = ${sqlText(auditId)}) = ${crawledPages.length}
         AND (SELECT COUNT(*) FROM audit_issues WHERE audit_id = ${sqlText(auditId)}) = ${detectedIssues.length}
         AND NOT EXISTS (
           SELECT 1 FROM audit_issues i
           WHERE i.audit_id = ${sqlText(auditId)} AND i.page_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM audit_pages p
               WHERE p.id = i.page_id AND p.audit_id = ${sqlText(auditId)}
             )
         )
       RETURNING id;`;
    const casResult = runD1Query(casSql, isRemote);
    if (!casResult || casResult.length !== 1 || casResult[0].id !== auditId) {
      throw new Error(
        `Audit CAS finalization failed for ${auditId} (updated ${casResult?.length ?? 0} rows, expected 1 matching id). State conflict or child count mismatch.`,
      );
    }

    // Stage 5 (FLEET-GH-05): Diagnostic Fleet Series Integration strictly scoped to effective roster and active projects (Sol P1-02, P1-03)
    let diagnosticFailed = false;
    try {
      const allRosterVersions = runD1Query(
        `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = 'shared-workspace';`,
        isRemote,
      );
      const effectiveRoster = selectEffectiveRosterVersion(allRosterVersions);
      if (!effectiveRoster) {
        if (mapping.expectedRosterVersionId || mapping.expectedMemberId) {
          console.error(
            `[ERROR] Expected approved roster '${mapping.expectedRosterVersionId}' for domain '${domain}' but no effective roster was found at publication.`,
          );
          diagnosticFailed = true;
        } else {
          console.warn(
            `[DIAGNOSTIC] No effective approved roster found for organization 'shared-workspace'. Skipping diagnostic series.`,
          );
        }
      } else {
        const rosterRows = runD1Query(
          `SELECT m.id AS member_id, m.version_id, v.organization_id
           FROM fleet_roster_members m
           JOIN fleet_roster_versions v ON v.id = m.version_id
           JOIN projects p ON p.id = m.project_id
           JOIN audits a ON a.id = ${sqlText(auditId)}
           WHERE v.id = ${sqlText(effectiveRoster.id)}
             AND v.organization_id = 'shared-workspace'
             AND lower(trim(m.canonical_host)) = lower(trim(${sqlText(domain)}))
             AND m.enrollment_state = 'active'
             AND m.repo_name = ${sqlText(mapping.repoName)}
             AND coalesce(m.publish_root, '.') = ${sqlText(normalizeGitRelativePath(mapping.publishRoot || "."))}
             AND p.id = ${sqlText(projectId)}
             AND p.organization_id = v.organization_id
             AND p.archived_at IS NULL
             AND a.status = 'completed'
             AND json_extract(a.config, '$.source') = 'github_repository_direct'
             AND json_extract(a.config, '$.repoName') = m.repo_name
             AND coalesce(json_extract(a.config, '$.publishRoot'), '.') = coalesce(m.publish_root, '.')
             ${mapping.expectedMemberId ? `AND m.id = ${sqlText(mapping.expectedMemberId)} AND json_extract(a.config, '$.rosterSource.memberId') = m.id` : ""}
             ${mapping.expectedRosterVersionId ? `AND v.id = ${sqlText(mapping.expectedRosterVersionId)} AND json_extract(a.config, '$.rosterSource.versionId') = v.id` : ""}
             ${mapping.expectedMemberId ? `AND json_extract(a.config, '$.rosterSource.projectId') = p.id AND lower(trim(json_extract(a.config, '$.rosterSource.canonicalHost'))) = lower(trim(m.canonical_host))` : ""};`,
          isRemote,
        );

        if (rosterRows.length > 0) {
          const { member_id, version_id, organization_id } = rosterRows[0];
          // Deterministic IDs derived from auditId, version, and member (Sol F02)
          const runId =
            "run_" +
            crypto
              .createHash("sha256")
              .update(`${auditId}:${version_id}:${member_id}:run`)
              .digest("hex")
              .slice(0, 16);
          const runItemId =
            "item_" +
            crypto
              .createHash("sha256")
              .update(`${auditId}:${version_id}:${member_id}:item`)
              .digest("hex")
              .slice(0, 16);
          const snapshotId =
            "snap_" +
            crypto
              .createHash("sha256")
              .update(`${auditId}:${version_id}:${member_id}:snap`)
              .digest("hex")
              .slice(0, 16);

          const score = Math.max(
            10,
            Math.min(
              100,
              Math.round(
                100 -
                  (detectedIssues.length / Math.max(1, htmlFiles.length)) * 100,
              ),
            ),
          );
          const grade =
            score >= 90
              ? "A"
              : score >= 80
                ? "B"
                : score >= 70
                  ? "C"
                  : score >= 60
                    ? "D"
                    : "F";
          const coverage =
            Math.round(
              (processedCount / Math.max(1, htmlFiles.length)) * 100 * 100,
            ) / 100;

          const runStatus = isComplete ? "completed" : "partial";
          const itemStatus = isComplete
            ? "completed"
            : processedCount > 0
              ? "partial"
              : "failed";
          const nowIso = new Date().toISOString();

          const isVerified = publishGuardedDiagnosticTriple(
            auditId,
            projectId,
            domain,
            member_id,
            version_id,
            organization_id,
            {
              score,
              grade,
              coverage,
              isComplete,
              processedCount,
              observedAt: nowIso,
            },
            isRemote,
          );
          if (!isVerified) {
            throw new Error(
              `Diagnostic triple verification failed for audit ${auditId}`,
            );
          }
          console.log(
            `[DIAGNOSTIC] Recorded and verified fleet diagnostic series run item for ${domain} (${runItemId}, score: ${score}, coverage: ${coverage}%, status: ${itemStatus})`,
          );
        } else {
          if (mapping.expectedRosterVersionId && mapping.expectedMemberId) {
            console.error(
              `[ERROR] Host '${domain}' was expected in roster '${mapping.expectedRosterVersionId}' (member '${mapping.expectedMemberId}') but failed diagnostic admission.`,
            );
            diagnosticFailed = true;
          } else {
            console.log(
              `[DIAGNOSTIC] Host '${domain}' is not in effective roster '${effectiveRoster.id}' or project is inactive. Skipped fleet diagnostic series.`,
            );
          }
        }
      }
    } catch (diagErr: any) {
      console.error(
        `[ERROR] Diagnostic fleet series linking failed:`,
        diagErr?.message || diagErr,
      );
      diagnosticFailed = true;
    }

    if (diagnosticFailed) {
      console.error(
        `[ERROR] Audit finalized in D1 for ${domain} but diagnostic fleet series recording failed.`,
      );
      process.exitCode = 1;
      return false;
    }

    console.log(
      `[SUCCESS] ${domain} audit successfully finalized in D1 as '${finalStatus}'! (${processedCount} pages, ${detectedIssues.length} issues)`,
    );
    return isComplete;
  } catch (d1Err: any) {
    console.error(
      `[ERROR] D1 persistence failed for ${domain}:`,
      d1Err?.message || d1Err,
    );
    // Mark audit as failed on error with observable CAS verification (Sol F9)
    try {
      const fallbackSql = `UPDATE audits
         SET status = 'failed',
             error_code = 'CHUNK_WRITE_FAILED',
             current_phase = 'failed',
             completed_at = datetime('now')
         WHERE id = ${sqlText(auditId)} AND status = 'running'
         RETURNING id;`;
      const fallbackRows = runD1Query(fallbackSql, isRemote);
      if (!fallbackRows || fallbackRows.length === 0) {
        console.warn(
          `[WARN] Fallback failure CAS updated 0 rows for ${auditId} on ${isRemote ? "open-seo-db-selfhost" : "DB"} (already finalized or missing).`,
        );
      } else if (fallbackRows.length > 1 || fallbackRows[0].id !== auditId) {
        throw new Error(
          `Unexpected fallback CAS result for ${auditId}: updated ${fallbackRows.length} rows`,
        );
      } else {
        console.log(
          `[FALLBACK] Finalized audit ${auditId} status as 'failed' (error_code: CHUNK_WRITE_FAILED) on ${isRemote ? "open-seo-db-selfhost" : "DB"}`,
        );
      }
    } catch (fallbackErr: any) {
      console.error(
        `[CRITICAL] Fallback failure CAS execution error for audit ${auditId} on ${isRemote ? "open-seo-db-selfhost" : "DB"}:`,
        fallbackErr?.message || fallbackErr,
      );
    }
    return false;
  }
}

function deterministicUuid(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0") + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
}

// Sol Round 21 F02: Atomic guarded diagnostic publication joining eligible relations before write
function publishGuardedDiagnosticTriple(
  auditId: string,
  projectId: string,
  domain: string,
  memberId: string,
  versionId: string,
  organizationId: string,
  metrics: {
    score: number;
    grade: string;
    coverage: number;
    isComplete: boolean;
    processedCount: number;
    observedAt?: string;
  },
  isRemote = true,
): boolean {
  const { score, grade, coverage, isComplete, processedCount, observedAt } =
    metrics;
  const runId =
    "run_" +
    crypto
      .createHash("sha256")
      .update(`${auditId}:${versionId}:${memberId}:run`)
      .digest("hex")
      .slice(0, 16);
  const runItemId =
    "item_" +
    crypto
      .createHash("sha256")
      .update(`${auditId}:${versionId}:${memberId}:item`)
      .digest("hex")
      .slice(0, 16);
  const snapshotId =
    "snap_" +
    crypto
      .createHash("sha256")
      .update(`${auditId}:${versionId}:${memberId}:snap`)
      .digest("hex")
      .slice(0, 16);

  const runStatus = isComplete ? "completed" : "partial";
  const itemStatus = isComplete
    ? "completed"
    : processedCount > 0
      ? "partial"
      : "failed";
  const nowIso = observedAt || new Date().toISOString();

  const diagnosticSql = [
    `INSERT INTO fleet_runs (id, organization_id, roster_version_id, rubric_version, trigger, requester_id, status, total_domains, completed_domains, failed_domains, started_at, completed_at)
     SELECT ${sqlText(runId)}, v.organization_id, v.id, 'v1', 'manual', 'github-audit-runner', ${sqlText(runStatus)}, 1, ${isComplete ? 1 : 0}, ${isComplete ? 0 : 1}, ${sqlText(nowIso)}, ${sqlText(nowIso)}
     FROM fleet_roster_versions v
     WHERE v.id = ${sqlText(versionId)} AND v.organization_id = ${sqlText(organizationId)}
     ON CONFLICT(id) DO UPDATE SET status = ${sqlText(runStatus)}, completed_at = ${sqlText(nowIso)};`,

    `WITH eligible AS (
       SELECT a.id, p.id AS project_id, m.id AS member_id, m.version_id
       FROM audits a
       JOIN projects p ON p.id = a.project_id AND p.archived_at IS NULL
       JOIN fleet_roster_members m ON m.project_id = p.id AND m.id = ${sqlText(memberId)}
       JOIN fleet_roster_versions v ON v.id = m.version_id
       WHERE a.id = ${sqlText(auditId)} AND a.status = 'completed'
         AND p.organization_id = ${sqlText(organizationId)} AND v.organization_id = ${sqlText(organizationId)}
         AND m.enrollment_state = 'active' AND m.version_id = ${sqlText(versionId)}
         AND lower(trim(p.domain)) = lower(trim(m.canonical_host))
         AND json_valid(a.config)
         AND json_extract(a.config, '$.source') = 'github_repository_direct'
         AND json_extract(a.config, '$.repoName') = m.repo_name
         AND json_type(a.config, '$.rosterSource.publishRoot') = 'text'
         AND json_extract(a.config, '$.rosterSource.publishRoot') = coalesce(m.publish_root, '.')
         AND json_extract(a.config, '$.rosterSource.versionId') = v.id
         AND json_extract(a.config, '$.rosterSource.memberId') = m.id
         AND json_extract(a.config, '$.rosterSource.projectId') = p.id
         AND lower(trim(json_extract(a.config, '$.rosterSource.canonicalHost'))) = lower(trim(m.canonical_host))
         AND json_extract(a.config, '$.rosterSource.repoName') = m.repo_name
     )
     INSERT INTO fleet_run_items (id, run_id, member_id, project_id, audit_id, primary_series_key, status, attempt_count, started_at, completed_at)
     SELECT ${sqlText(runItemId)}, ${sqlText(runId)}, member_id, project_id, id, 'diagnostic', ${sqlText(itemStatus)}, 1, ${sqlText(nowIso)}, ${sqlText(nowIso)}
     FROM eligible
     ON CONFLICT(id) DO UPDATE SET status = ${sqlText(itemStatus)}, completed_at = ${sqlText(nowIso)};`,

    `WITH eligible_item AS (
       SELECT fri.id AS run_item_id, fri.member_id, fri.project_id
       FROM fleet_run_items fri
       JOIN fleet_runs fr ON fr.id = fri.run_id
       JOIN fleet_roster_members rm ON rm.id = fri.member_id AND rm.version_id = fr.roster_version_id
       WHERE fri.id = ${sqlText(runItemId)}
         AND fri.audit_id = ${sqlText(auditId)}
         AND fri.status IN ('completed', 'partial')
     )
     INSERT INTO fleet_snapshots (id, run_item_id, member_id, project_id, canonical_host, score, grade, coverage, series_key, score_technical, score_internal_links, score_on_page, score_mobile_perf, score_schema, score_ai_readiness, observed_at)
     SELECT ${sqlText(snapshotId)}, run_item_id, member_id, project_id, ${sqlText(domain)}, ${score}, ${sqlText(grade)}, ${coverage}, 'diagnostic', NULL, NULL, NULL, NULL, NULL, NULL, ${sqlText(nowIso)}
     FROM eligible_item
     ON CONFLICT(id) DO UPDATE SET score = ${score}, grade = ${sqlText(grade)}, coverage = ${coverage}, observed_at = ${sqlText(nowIso)};`,
  ];

  executeD1SqlStatements(diagnosticSql, isRemote);
  return verifyDiagnosticTriple(
    runId,
    runItemId,
    snapshotId,
    auditId,
    organizationId,
    versionId,
    memberId,
    projectId,
    domain,
    runStatus,
    itemStatus,
    isRemote,
  );
}

function verifyDiagnosticTriple(
  runId: string,
  runItemId: string,
  snapshotId: string,
  auditId: string,
  orgId: string,
  rosterId: string,
  memberId: string,
  projectId: string,
  canonicalHost: string,
  expectedRunStatus = "completed",
  expectedItemStatus = "completed",
  isRemote = true,
): boolean {
  const query = `
    SELECT r.id as run_id, i.id as item_id, s.id as snap_id
    FROM fleet_runs r
    JOIN fleet_run_items i ON i.run_id = r.id
    JOIN fleet_snapshots s ON s.run_item_id = i.id
    WHERE r.id = ${sqlText(runId)}
      AND i.id = ${sqlText(runItemId)}
      AND s.id = ${sqlText(snapshotId)}
      AND r.organization_id = ${sqlText(orgId)}
      AND r.roster_version_id = ${sqlText(rosterId)}
      AND i.audit_id = ${sqlText(auditId)}
      AND i.member_id = ${sqlText(memberId)}
      AND i.project_id = ${sqlText(projectId)}
      AND s.member_id = ${sqlText(memberId)}
      AND s.project_id = ${sqlText(projectId)}
      AND s.canonical_host = ${sqlText(canonicalHost)}
      AND i.primary_series_key = 'diagnostic'
      AND s.series_key = 'diagnostic'
      AND r.status = ${sqlText(expectedRunStatus)}
      AND i.status = ${sqlText(expectedItemStatus)}
      AND 1 = (
        SELECT count(*)
        FROM fleet_run_items fri
        JOIN fleet_runs fr ON fr.id = fri.run_id
        JOIN fleet_snapshots fs ON fs.run_item_id = fri.id
        WHERE fri.audit_id = ${sqlText(auditId)}
          AND fri.member_id = ${sqlText(memberId)}
          AND fr.roster_version_id = ${sqlText(rosterId)}
          AND fri.primary_series_key = 'diagnostic'
          AND fs.series_key = 'diagnostic'
          AND fr.status = ${sqlText(expectedRunStatus)}
          AND fri.status = ${sqlText(expectedItemStatus)}
      );
  `;
  const res = runD1Query(query, isRemote);
  return res.length === 1;
}

function repairDiagnosticObservation(
  auditId: string,
  projectId: string,
  domain: string,
  expectedSource?: RosterSource,
  isRemote = true,
): boolean {
  try {
    const allRosterVersions = runD1Query(
      `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = 'shared-workspace';`,
      isRemote,
    );
    const effectiveRoster = selectEffectiveRosterVersion(allRosterVersions);
    if (!effectiveRoster) return false;

    const rosterRows = runD1Query(
      `SELECT m.id AS member_id, m.version_id, v.organization_id, m.repo_name, m.publish_root
       FROM fleet_roster_members m
       JOIN fleet_roster_versions v ON v.id = m.version_id
       JOIN projects p ON p.id = m.project_id
       WHERE v.id = ${sqlText(effectiveRoster.id)}
         AND v.organization_id = 'shared-workspace'
         AND lower(trim(m.canonical_host)) = lower(trim(${sqlText(domain)}))
         AND m.enrollment_state = 'active'
         AND p.id = ${sqlText(projectId)}
         AND p.organization_id = v.organization_id
         AND p.archived_at IS NULL
         ${expectedSource ? `AND m.id = ${sqlText(expectedSource.memberId)}` : ""}
         ${expectedSource ? `AND v.id = ${sqlText(expectedSource.versionId)}` : ""}
         ${expectedSource ? `AND m.repo_name = ${sqlText(expectedSource.repoName)}` : ""}
         ${expectedSource ? `AND coalesce(m.publish_root, '.') = ${sqlText(normalizeGitRelativePath(expectedSource.publishRoot))}` : ""};`,
      isRemote,
    );
    if (rosterRows.length === 0) return false;

    const { member_id, version_id, organization_id } = rosterRows[0];
    const runId =
      "run_" +
      crypto
        .createHash("sha256")
        .update(`${auditId}:${version_id}:${member_id}:run`)
        .digest("hex")
        .slice(0, 16);
    const runItemId =
      "item_" +
      crypto
        .createHash("sha256")
        .update(`${auditId}:${version_id}:${member_id}:item`)
        .digest("hex")
        .slice(0, 16);
    const snapshotId =
      "snap_" +
      crypto
        .createHash("sha256")
        .update(`${auditId}:${version_id}:${member_id}:snap`)
        .digest("hex")
        .slice(0, 16);

    const counts = runD1Query(
      `SELECT a.pages_crawled, a.pages_total, a.completed_at, a.status, a.config,
              (SELECT COUNT(*) FROM audit_issues WHERE audit_id = a.id) as issue_count,
              (SELECT COUNT(*) FROM audit_pages WHERE audit_id = a.id) as page_count,
              (SELECT COUNT(*) FROM audit_issues i WHERE i.audit_id = a.id AND i.page_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audit_pages p WHERE p.id = i.page_id AND p.audit_id = a.id)) as orphaned_count
       FROM audits a WHERE a.id = ${sqlText(auditId)} AND a.project_id = ${sqlText(projectId)};`,
      isRemote,
    );
    if (counts.length === 0) return false;
    const {
      pages_crawled,
      pages_total,
      completed_at,
      issue_count,
      page_count,
      orphaned_count,
      status,
      config: rawConfig,
    } = counts[0];
    if (status !== "completed") return false;
    const crawled = Number(pages_crawled || 0);
    const total = Number(pages_total || 0);
    if (total === 0 || crawled < total) return false;
    if (Number(page_count || 0) < total) return false;
    if (Number(orphaned_count || 0) > 0) return false;

    // Sol F01: Validate audit config source tuple matches expectedSource across all 6 fields
    if (expectedSource) {
      try {
        const cfg = JSON.parse(rawConfig || "{}");
        if (cfg.source !== "github_repository_direct") return false;
        if (cfg.repoName !== expectedSource.repoName) return false;
        const auditRoot = normalizeGitRelativePath(cfg.publishRoot || ".");
        const expectedRoot = normalizeGitRelativePath(
          expectedSource.publishRoot || ".",
        );
        if (auditRoot !== expectedRoot) return false;
        if (!cfg.rosterSource) return false;
        const rs = cfg.rosterSource;
        if (
          rs.versionId !== expectedSource.versionId ||
          rs.memberId !== expectedSource.memberId ||
          rs.projectId !== expectedSource.projectId ||
          rs.canonicalHost?.toLowerCase().trim() !==
            expectedSource.canonicalHost.toLowerCase().trim() ||
          rs.repoName !== expectedSource.repoName ||
          normalizeGitRelativePath(rs.publishRoot || ".") !== expectedRoot
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }

    const issues = Number(issue_count || 0);

    const score = Math.max(
      10,
      Math.min(100, Math.round(100 - (issues / Math.max(1, total)) * 100)),
    );
    const grade =
      score >= 90
        ? "A"
        : score >= 80
          ? "B"
          : score >= 70
            ? "C"
            : score >= 60
              ? "D"
              : "F";
    const coverage =
      Math.round((crawled / Math.max(1, total)) * 100 * 100) / 100;
    const observedAt = completed_at || new Date().toISOString();

    const isVerified = publishGuardedDiagnosticTriple(
      auditId,
      projectId,
      domain,
      member_id,
      version_id,
      organization_id,
      {
        score,
        grade,
        coverage,
        isComplete: true,
        processedCount: crawled,
        observedAt,
      },
      isRemote,
    );
    if (isVerified) {
      console.log(
        `[REPAIR] Successfully repaired diagnostic observation for ${domain} (${auditId})`,
      );
      return true;
    }
  } catch (err: any) {
    console.error(
      `[REPAIR ERROR] Failed to repair diagnostic observation:`,
      err?.message || err,
    );
  }
  return false;
}

type FleetAction =
  | {
      kind: "repair";
      domain: string;
      projectId: string;
      auditId: string;
      expectedSource?: RosterSource;
    }
  | {
      kind: "audit";
      mapping: RepoMapping;
      head: GitHubHeadDescriptor;
    };

async function main() {
  const args = parseArgs({
    options: {
      domain: { type: "string", short: "d" },
      limit: { type: "string", short: "l" },
      all: { type: "boolean", short: "a" },
      force: { type: "boolean", short: "f" },
      workspace: { type: "boolean", short: "w" },
      archive: { type: "boolean" },
      "max-pages": { type: "string", short: "m", default: "10000" },
      "roster-id": { type: "string" },
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (args.positionals.length > 0) {
    console.error(
      `[ERROR] Stray positional arguments detected (${args.positionals.join(", ")}). Positional arguments not permitted.`,
    );
    process.exit(1);
  }

  // Sol F2: Mutual exclusivity of --local and --remote
  const hasRemoteArg = process.argv.includes("--remote");
  const hasLocalArg = process.argv.includes("--local");
  if (hasRemoteArg && hasLocalArg) {
    console.error(
      "[ERROR] Conflicting flags: cannot specify both --remote and --local.",
    );
    process.exit(1);
  }
  const isRemote = !hasLocalArg;

  console.log("=== OpenSEO Zero-Limit GitHub Repository Audit Runner ===");

  // Sol F2: Strict tagged selector validation upfront
  let targetDomain: string | undefined;
  if (args.values.domain !== undefined) {
    const raw = String(args.values.domain).trim().toLowerCase();
    if (!raw || !isValidCanonicalHostname(raw)) {
      console.error(
        `[ERROR] --domain requires a canonical RFC 1123 hostname. Received: "${args.values.domain}"`,
      );
      process.exit(1);
    }
    targetDomain = raw;
  }

  let limit: number | undefined;
  if (args.values.limit !== undefined) {
    const rawLimit = String(args.values.limit);
    if (
      !/^[1-9][0-9]*$/.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit))
    ) {
      console.error(
        "[ERROR] Invalid --limit value. Must be a safe positive integer.",
      );
      process.exit(1);
    }
    limit = parseInt(rawLimit, 10);
  }
  const force = !!args.values.force;
  const isWorkspace = !!args.values.workspace;

  // Sol P2-04: Strict numeric and scope validation
  const rawMaxPages = args.values["max-pages"]
    ? String(args.values["max-pages"])
    : "10000";
  const numMaxPages = Number(rawMaxPages);
  if (
    !/^[1-9][0-9]*$/.test(rawMaxPages) ||
    !Number.isSafeInteger(numMaxPages) ||
    numMaxPages > 10000
  ) {
    console.error(
      "[ERROR] Invalid --max-pages value. Must be a safe positive integer between 1 and 10000.",
    );
    process.exit(1);
  }
  const maxPages = numMaxPages;

  const scopeCount =
    Number(targetDomain !== undefined) +
    Number(args.values.all === true) +
    Number(args.values.limit !== undefined);
  if (scopeCount !== 1) {
    console.error(
      "[ERROR] Missing or conflicting execution scope. Specify exactly one of --domain <canonical-host>, --all, or --limit <n>.",
    );
    process.exit(1);
  }

  // Load project mappings from D1 with duplicate domain detection (Sol F01)
  const projectRows = runD1Query(
    "SELECT id, domain FROM projects WHERE organization_id = 'shared-workspace' AND domain IS NOT NULL AND archived_at IS NULL;",
    isRemote,
  );
  const projectIdByDomain = new Map<string, string>();
  for (const p of projectRows) {
    const dom = p.domain.toLowerCase().trim();
    if (projectIdByDomain.has(dom) && projectIdByDomain.get(dom) !== p.id) {
      console.error(
        `[ERROR] Conflicting active project IDs found for domain '${dom}': ${projectIdByDomain.get(dom)} and ${p.id}.`,
      );
      process.exit(1);
    }
    projectIdByDomain.set(dom, p.id);
  }

  const rawRosterId = args.values["roster-id"];
  const expectedRosterId = rawRosterId ? String(rawRosterId).trim() : undefined;
  if (expectedRosterId !== undefined && expectedRosterId === "") {
    console.error("[ERROR] --roster-id cannot be empty.");
    process.exit(1);
  }
  if (expectedRosterId !== undefined && isWorkspace) {
    console.error(
      "[ERROR] Conflicting options: --workspace cannot be combined with --roster-id.",
    );
    process.exit(1);
  }

  // Load effective approved roster for admission scoping (Sol F01)
  const allRosterVersions = runD1Query(
    `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = 'shared-workspace';`,
    isRemote,
  );
  const effectiveRoster = selectEffectiveRosterVersion(allRosterVersions);

  if (expectedRosterId !== undefined) {
    if (!effectiveRoster || effectiveRoster.id !== expectedRosterId) {
      console.error(
        `[ERROR] Planned roster '${expectedRosterId}' is no longer effective on the execution DB (effective is '${effectiveRoster?.id ?? "none"}').`,
      );
      process.exit(1);
    }
  }

  if (!isWorkspace && !effectiveRoster) {
    console.error(
      "[ERROR] No effective approved roster found for organization 'shared-workspace'. Pass --workspace to audit wider inventory or approve a roster.",
    );
    process.exit(1);
  }

  const approvedHosts = new Set<string>();
  const approvedMembersByHost = new Map<
    string,
    {
      memberId: string;
      versionId: string;
      projectId: string;
      canonicalHost: string;
      repoName: string | null;
      publishRoot: string;
    }
  >();
  if (effectiveRoster) {
    const rosterRows = runD1Query(
      `SELECT m.id AS member_id, m.version_id, m.canonical_host, m.project_id, m.repo_name, m.publish_root
       FROM fleet_roster_members m
       JOIN fleet_roster_versions v ON v.id = m.version_id
       JOIN projects p ON p.id = m.project_id
                      AND p.organization_id = v.organization_id
                      AND p.archived_at IS NULL
                      AND lower(trim(p.domain)) = lower(trim(m.canonical_host))
       WHERE v.id = ${sqlText(effectiveRoster.id)}
         AND v.organization_id = 'shared-workspace'
         AND m.enrollment_state = 'active'
         AND m.project_id IS NOT NULL;`,
      isRemote,
    );
    for (const r of rosterRows) {
      const host = r.canonical_host.toLowerCase().trim();
      const activeProjId = projectIdByDomain.get(host);
      if (!activeProjId || activeProjId !== r.project_id) {
        console.warn(
          `[ROSTER] Stale or mismatched project mapping for host '${host}': roster project_id='${r.project_id}', active project_id='${activeProjId}'. Excluding from approved candidates.`,
        );
        continue;
      }
      approvedMembersByHost.set(host, {
        memberId: r.member_id,
        versionId: r.version_id,
        projectId: activeProjId,
        canonicalHost: host,
        repoName: r.repo_name ? String(r.repo_name).trim() : null,
        publishRoot: r.publish_root
          ? normalizeGitRelativePath(String(r.publish_root))
          : ".",
      });
      approvedHosts.add(host);
    }
  }

  const repoMappings = loadRepoMappings();
  console.log(
    `Loaded ${repoMappings.size} repository mappings from manifest & PROJECTS_GITHUB.md.`,
  );

  // Build deterministic planned actions list (Sol F01, F02: respects approved roster vs workspace scope)
  const plannedActions: FleetAction[] = [];
  let discoveryFailures = 0;

  if (targetDomain) {
    const approvedMember = approvedMembersByHost.get(targetDomain);
    let projId: string | undefined;
    let repoName: string | undefined;
    let publishRoot = ".";

    if (!isWorkspace) {
      if (effectiveRoster && !approvedHosts.has(targetDomain)) {
        console.error(
          `[ERROR] Domain '${targetDomain}' is not in approved fleet roster '${effectiveRoster.id}'. Pass --workspace to audit wider inventory.`,
        );
        process.exit(1);
      }
      if (!approvedMember) {
        console.error(
          `[ERROR] Domain '${targetDomain}' is not found among approved active roster members. Pass --workspace to audit wider inventory.`,
        );
        process.exit(1);
      }
      if (
        !approvedMember.repoName ||
        !isValidRepoSlug(approvedMember.repoName)
      ) {
        console.error(
          `[ERROR] Domain '${targetDomain}' has no approved repository mapping in roster '${effectiveRoster?.id}'. Use edge mode or link an approved repository in the roster.`,
        );
        process.exit(1);
      }
      projId = approvedMember.projectId;
      repoName = approvedMember.repoName;
      publishRoot = approvedMember.publishRoot;
    } else {
      const fallbackRepo = repoMappings.get(targetDomain);
      projId = approvedMember?.projectId || projectIdByDomain.get(targetDomain);
      repoName = approvedMember?.repoName || fallbackRepo?.repoName;
      publishRoot =
        approvedMember?.publishRoot || (fallbackRepo?.publishRoot ?? ".");
    }

    if (!projId || !repoName) {
      console.error(
        `[ERROR] Domain '${targetDomain}' is not found among enrolled projects or repository mappings.`,
      );
      process.exit(1);
    }

    const expectedRosterSource: RosterSource | null =
      effectiveRoster && approvedMember
        ? {
            versionId: effectiveRoster.id,
            memberId: approvedMember.memberId,
            projectId: projId,
            canonicalHost: targetDomain,
            repoName,
            publishRoot: normalizeGitRelativePath(publishRoot),
          }
        : null;

    const head = resolveGitHubHead(repoName);
    const matchingAudit = !force
      ? findMatchingCompletedAudit(
          projId,
          repoName,
          publishRoot,
          head.commitSha,
          expectedRosterSource,
          isRemote,
        )
      : null;

    if (!force && matchingAudit) {
      const isRosterMember = approvedHosts.has(targetDomain);
      if (
        isRosterMember &&
        !matchingAudit.hasDiagnostic &&
        expectedRosterSource
      ) {
        plannedActions.push({
          kind: "repair",
          domain: targetDomain,
          projectId: projId,
          auditId: matchingAudit.id,
          expectedSource: expectedRosterSource,
        });
      } else {
        console.log(
          `[REUSED] Project for domain '${targetDomain}' already has a completed GitHub source audit matching ${repoName} at commit ${head.commitSha.slice(0, 10)}. Use --force to re-audit.`,
        );
        return;
      }
    } else {
      plannedActions.push({
        kind: "audit",
        mapping: {
          domain: targetDomain,
          repoName,
          publishRoot,
          projectId: projId,
          expectedRosterVersionId: effectiveRoster?.id,
          expectedMemberId: approvedMember?.memberId,
        },
        head,
      });
    }
  } else {
    const candidateDomains =
      !isWorkspace && effectiveRoster
        ? Array.from(approvedHosts)
        : Array.from(repoMappings.keys());

    for (const dom of candidateDomains) {
      if (limit !== undefined && plannedActions.length >= limit) {
        break;
      }
      const approvedMember = approvedMembersByHost.get(dom);
      const isEligible = isWorkspace || approvedHosts.has(dom);
      if (!isEligible) continue;

      let projId: string | undefined;
      let repoName: string | undefined;
      let publishRoot = ".";

      if (!isWorkspace) {
        if (
          !approvedMember?.repoName ||
          !isValidRepoSlug(approvedMember.repoName)
        ) {
          // Unmapped member in approved roster: skip, do NOT plan action or substitute unapproved repo
          continue;
        }
        projId = approvedMember.projectId;
        repoName = approvedMember.repoName;
        publishRoot = approvedMember.publishRoot;
      } else {
        const fallbackRepo = repoMappings.get(dom);
        projId = approvedMember?.projectId || projectIdByDomain.get(dom);
        repoName = approvedMember?.repoName || fallbackRepo?.repoName;
        publishRoot =
          approvedMember?.publishRoot || (fallbackRepo?.publishRoot ?? ".");
      }

      if (projId && repoName) {
        try {
          const expectedRosterSource: RosterSource | null =
            effectiveRoster && approvedMember
              ? {
                  versionId: effectiveRoster.id,
                  memberId: approvedMember.memberId,
                  projectId: projId,
                  canonicalHost: dom,
                  repoName,
                  publishRoot: normalizeGitRelativePath(publishRoot),
                }
              : null;

          const head = resolveGitHubHead(repoName);
          const matchingAudit = !force
            ? findMatchingCompletedAudit(
                projId,
                repoName,
                publishRoot,
                head.commitSha,
                expectedRosterSource,
                isRemote,
              )
            : null;

          if (!force && matchingAudit) {
            const isRosterMember = approvedHosts.has(dom);
            if (
              isRosterMember &&
              !matchingAudit.hasDiagnostic &&
              expectedRosterSource
            ) {
              plannedActions.push({
                kind: "repair",
                domain: dom,
                projectId: projId,
                auditId: matchingAudit.id,
                expectedSource: expectedRosterSource,
              });
            } else {
              continue; // Reused
            }
          } else {
            plannedActions.push({
              kind: "audit",
              mapping: {
                domain: dom,
                repoName,
                publishRoot,
                projectId: projId,
                expectedRosterVersionId: effectiveRoster?.id,
                expectedMemberId: approvedMember?.memberId,
              },
              head,
            });
          }
        } catch (e: any) {
          discoveryFailures++;
          console.warn(
            `[DISCOVERY SKIP] Skipping ${dom} (${repoName}): ${e?.message}`,
          );
        }
      }
    }
  }

  // Sol F2: Apply limit to the combined list of repairs and fresh audits before write selection
  const selectedActions =
    limit !== undefined ? plannedActions.slice(0, limit) : plannedActions;
  console.log(
    `Executing ${selectedActions.length} planned fleet actions (Total planned: ${plannedActions.length}, Limit: ${limit ?? "none"})...`,
  );

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < selectedActions.length; i++) {
    const action = selectedActions[i];
    if (action.kind === "repair") {
      console.log(
        `\n[${i + 1}/${selectedActions.length}] [REPAIR] Repairing diagnostic observation for ${action.domain} (${action.auditId})...`,
      );
      const ok = repairDiagnosticObservation(
        action.auditId,
        action.projectId,
        action.domain,
        action.expectedSource,
        isRemote,
      );
      if (ok) {
        successCount++;
      } else {
        console.error(
          `[REPAIR FAILED] Failed to repair diagnostic observation for ${action.domain} (${action.auditId}). Aborting without fallback Git crawl (Sol F4).`,
        );
        failCount++;
      }
    } else {
      const c = action.mapping;
      console.log(
        `\n[${i + 1}/${selectedActions.length}] [AUDIT] Starting audit for ${c.domain} (${c.repoName})...`,
      );
      try {
        const discovered = fetchGitHubTree(action.head);
        const ok = await auditRepository(
          c,
          action.head,
          discovered.tree,
          maxPages,
          !!args.values.archive,
          isRemote,
        );
        if (ok) successCount++;
        else failCount++;
      } catch (err: any) {
        console.error(`Audit failed for ${c.domain}:`, err?.message || err);
        failCount++;
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(
    `GitHub Fleet Audit Completed! Success: ${successCount}, Failed: ${failCount}, Discovery Failures: ${discoveryFailures}`,
  );
  console.log(`======================================================`);

  if (failCount > 0 || discoveryFailures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal GitHub Fleet Audit Runner Error:", err);
  process.exit(1);
});
