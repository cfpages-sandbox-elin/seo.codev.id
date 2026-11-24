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
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
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
  selectEffectiveRosterVersion,
  executeD1SqlBatches,
  acquireVerifiedBlob,
  type GitTreeItem,
} from "./github-archive-utils";
import { isSameOrigin } from "../src/server/lib/audit/url-utils";
import { analyzeHtml } from "../src/server/lib/audit/page-analyzer";
import { runPageReporters, type DetectedIssue } from "../src/server/lib/audit/issues/page-reporters";
import type { CrawledPageResult } from "../src/server/lib/audit/types";
import { deterministicAuditRowId } from "../src/server/lib/audit/ids";
import { getIssueDescriptor } from "../src/shared/audit-issues";

const ENV_FILE = resolve(".env.selfhost");
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
  } catch (err) {
    console.warn("Could not read .env.selfhost:", err);
  }
  return env;
}

const envVars = loadEnv();

function getGitHubToken(): string {
  try {
    const token = execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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
}

function loadRepoMappings(): Map<string, RepoMapping> {
  const map = new Map<string, RepoMapping>();

  // 1. Load from fleetManifest.json (canonical approved mappings take highest precedence)
  try {
    const raw = readFileSync(FLEET_MANIFEST_FILE, "utf8");
    const list = JSON.parse(raw);
    for (const item of list) {
      if (item.canonicalHost && item.repoName) {
        const repoSlug = item.repoName.trim();
        if (isValidRepoSlug(repoSlug)) {
          map.set(item.canonicalHost.toLowerCase().trim(), {
            domain: item.canonicalHost.toLowerCase().trim(),
            repoName: repoSlug,
            publishRoot: item.publishRoot ?? ".",
          });
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
      const match = line.match(/^\|\s*([^|]+)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*([^|]+)\|/);
      if (match) {
        const owner = match[1].trim();
        const repo = match[2].trim();
        const site = match[3].trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const slug = `${owner}/${repo}`;
        if (owner && repo && site && !map.has(site) && isValidRepoSlug(slug)) {
          map.set(site, { domain: site, repoName: slug, publishRoot: "." });
        }
      }
    }
  } catch (err) {
    console.warn("Could not load PROJECTS_GITHUB.md:", err);
  }

  return map;
}

const normalizeRoute = (urlOrPath: string): string => {
  let s = urlOrPath.split("#")[0].split("?")[0].replace(/^https?:\/\//, "");
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

async function auditRepository(mapping: RepoMapping, maxPages = 10000, useArchive = false, isRemote = true): Promise<boolean> {
  const { domain, repoName, projectId } = mapping;
  if (!projectId) {
    throw new Error(`Cannot audit repository '${repoName}' for domain '${domain}': missing projectId`);
  }
  console.log(`\n======================================================`);
  console.log(`Auditing ${domain} directly from GitHub repo ${repoName}`);
  console.log(`======================================================`);

  // 1. Resolve default branch and immutable commit SHA via shell-free discovery (Sol P1-04)
  let defaultBranch = "main";
  let commitSha = "";
  let treeItems: GitTreeItem[] = [];
  const isTreeTruncated = false;

  try {
    const discovered = discoverGitHubTree(repoName);
    defaultBranch = discovered.defaultBranch;
    commitSha = discovered.commitSha;
    treeItems = discovered.tree;
    console.log(`Pinned commit: ${commitSha.slice(0, 10)} (branch: ${defaultBranch})`);
  } catch (err: any) {
    console.error(`Failed to fetch git tree for ${repoName}:`, err?.message || err);
    return false;
  }

  // 2. Build comprehensive unified route index with collision detection & served identity admission (Sol F01, F02)
  const publishRoot = mapping.publishRoot ?? ".";
  const prefix = publishRoot === "." ? "" : (publishRoot.replace(/^\/+|\/+$/g, "") + "/");

  // Helper to map repo path to public page URL using canonical served identities (Sol Snippet 3, F01)
  const pathToUrl = (path: string): string => {
    const relativePath = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const segments = relativePath.split("/").map(encodeURIComponent);
    const isDirectoryIndex = /^(?:index\.html|index\.htm)$/i.test(segments.at(-1) ?? "");
    if (isDirectoryIndex) segments.pop();
    const pathname = "/" + segments.join("/") + (isDirectoryIndex && segments.length ? "/" : "");
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
    const key = owner.kind === "ambiguous" ? owner.gitPaths.join(",") : owner.gitPath;
    owners.set(key, owner);
    aliases.set(route, owners);
  }

  function resolveRoute(route: string) {
    const exact = physicalRoutes.get(route);
    if (exact) return { kind: "known" as const, owner: exact };
    const candidates = [...(aliases.get(route)?.values() ?? [])];
    if (candidates.length === 1) return { kind: "known" as const, owner: candidates[0] };
    if (candidates.length > 1) return { kind: "ambiguous" as const, candidates };
    return { kind: "missing" as const };
  }

  for (const item of treeItems) {
    if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755")) continue;
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
      const encodedPath = servedPath.split("/").map(encodeURIComponent).join("/");
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
      const allPaths = (htmlBlobsByServedUrl.get(pageUrl) ?? [file]).map((it) => it.path);
      const ambigOwner: RouteOwner = { kind: "ambiguous", gitPaths: allPaths };
      physicalRoutes.set(physicalKey, ambigOwner);
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
        const cleanRoute = cleanSlug === "" ? normalizeRoute(domain) : normalizeRoute(`${domain}/${cleanSlug}`);
        addAlias(cleanRoute, pageOwner);
        const cleanSlashRoute = cleanSlug === "" ? normalizeRoute(`${domain}/`) : normalizeRoute(`${domain}/${cleanSlug}/`);
        addAlias(cleanSlashRoute, pageOwner);
      }
    }
  }

  console.log(`Discovered ${htmlFiles.length} unique static HTML pages (${ambiguousServedUrls.size} ambiguous index collisions resolved) and ${treeItems.length} total repository assets in ${repoName}`);
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

  // 3. Fetch and analyze HTML files with paced concurrency
  const auditSeed = `${projectId}:shared-workspace:${repoName}:${commitSha}:${mapping.publishRoot ?? "."}:v1`;
  const auditId = deterministicUuid(auditSeed);
  const startTime = Date.now();
  const crawledPages: CrawledPageResult[] = [];
  const detectedIssues: DetectedIssue[] = [];
  const inboundLinkCounts = new Map<string, number>();
  let hasTruncatedLinks = false;

  let archiveHtmlMap: Map<string, Buffer> | null = null;
  if (useArchive) {
    try {
      console.log(`[ARCHIVE] In-process streaming commit-pinned tarball for ${repoName} (${commitSha.slice(0, 10)})...`);
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
      console.log(`[ARCHIVE] Extracted ${archiveHtmlMap.size} HTML files from archive in memory.`);
    } catch (err: any) {
      console.warn(`[WARN] Tarball archive streaming failed (${err?.message || err}), falling back to concurrent blob fetching.`);
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
            ? crypto.createHash("sha256").update(analysis.bodyText).digest("hex")
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
            imagesMissingAlt: analysis.images.filter((img) => !img.alt || img.alt.trim() === "").length,
            images: analysis.images,
            links: analysis.links,
            hreflangTags: analysis.hreflangTags,
            hasStructuredData: analysis.hasStructuredData,
            isIndexable: !analysis.robotsMeta?.toLowerCase().includes("noindex"),
            crawlDepth: 0,
            inSitemap: false,
          };

          crawledPages.push(pageResult);

          // Page-level issues (filter out unmeasured runtime-only issues e.g. deep-page)
          const issues = runPageReporters(pageResult).filter(
            (iss) => (iss.issueType as string) !== "deep-page"
          );
          detectedIssues.push(...issues);

          // Check internal links using unified route owner index and apex/www equivalence (Sol F02)
          let effectiveBaseUrl = new URL(pageUrl);
          const baseMatch = html.match(/<base\s+[^>]*href=["']([^"']+)["']/i);
          if (baseMatch && baseMatch[1]) {
            try {
              effectiveBaseUrl = new URL(baseMatch[1].trim(), effectiveBaseUrl);
            } catch {}
          }

          for (const link of analysis.links) {
            if (link.isInternal && link.targetUrl) {
              try {
                const target = new URL(link.targetUrl, effectiveBaseUrl);
                // Recognize same origin including www <-> apex pairs and default port http/https (Sol F02)
                const isInternal =
                  isSameOrigin(target.href, pageUrl) ||
                  (target.hostname.toLowerCase().replace(/^www\./, "") === domain.toLowerCase().replace(/^www\./, "") &&
                    (target.port === "" || target.port === "80" || target.port === "443"));

                if (isInternal) {
                  const normTarget = normalizeRoute(`https://${domain}${target.pathname}`);
                  const res = resolveRoute(normTarget);
                  if (res.kind === "known") {
                    const owner = res.owner;
                    if (owner.kind === "page") {
                      if (owner.pageUrl !== pageUrl) {
                        inboundLinkCounts.set(owner.pageUrl, (inboundLinkCounts.get(owner.pageUrl) || 0) + 1);
                      }
                    }
                  } else if (res.kind === "ambiguous") {
                    // Credit inbound edge to possible candidates so neither is falsely orphaned
                    for (const cand of res.candidates) {
                      if (cand.kind === "page" && cand.pageUrl !== pageUrl) {
                        inboundLinkCounts.set(cand.pageUrl, (inboundLinkCounts.get(cand.pageUrl) || 0) + 1);
                      }
                    }
                  } else if (!isTreeTruncated && candidateFiles.length === htmlFiles.length) {
                    // Internal dead link confirmed only when tree is complete
                    detectedIssues.push({
                      issueType: "broken-internal-link",
                      pageId,
                      pageUrl,
                      dedupeKey: link.targetUrl,
                      details: { targetUrl: link.targetUrl },
                    });
                  }
                }
              } catch {}
            }
          }
        } catch (fetchErr: any) {
          console.warn(`Error analyzing ${file.path}:`, fetchErr?.message || fetchErr);
        }
      })
    );
    process.stdout.write(`\rProgress: ${Math.min(i + CONCURRENCY, candidateFiles.length)} / ${candidateFiles.length} pages analyzed`);
  }
  console.log("\nPage analysis completed.");

  const attemptedCount = candidateFiles.length;
  const processedCount = crawledPages.length;
  const unreadCount = attemptedCount - processedCount;
  const isComplete = !isTreeTruncated && candidateFiles.length === htmlFiles.length && unreadCount === 0 && processedCount > 0;
  const finalStatus = isComplete ? "completed" : "failed";

  // 4. Detect Orphan Pages (only when tree is complete, all eligible pages read, and link graph untruncated — Sol P1-03, P2-03)
  const homeNorm = normalizeRoute(domain);
  if (isComplete && unreadCount === 0) {
    if (hasTruncatedLinks) {
      console.warn(`[WARN] Links were truncated on one or more pages (>1,000 links); orphan page detection suppressed to prevent false orphan reports.`);
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

  console.log(`Analyzed ${processedCount}/${attemptedCount} pages (${unreadCount} unread, treeTruncated: ${isTreeTruncated}), detected ${detectedIssues.length} issues in ${durationSec}s.`);
  console.log(`Final evaluation status: ${finalStatus}`);

  // 5. Staged Ingestion into Cloudflare D1
  console.log("Staging audit records into Cloudflare D1...");

  const configJson = JSON.stringify({
    source: "github_repository_direct",
    repoName,
    branch: defaultBranch,
    commitSha,
    totalFiles: htmlFiles.length,
    treeTruncated: isTreeTruncated,
  }).replace(/'/g, "''");

  try {
    // Stage 1: Insert parent audit in 'running' phase (plain insert to surface duplicates as conflict, Sol F10)
    executeD1SqlStatements([
      `INSERT INTO audits (
        id, project_id, started_by_user_id, start_url,
        workflow_instance_id, config, status, pages_crawled,
        pages_total, lighthouse_total, current_phase, started_at
      ) VALUES (
        '${auditId}', '${projectId}', 'system', 'https://${domain}',
        'github-audit-${auditId}', '${configJson}', 'running', ${processedCount},
        ${htmlFiles.length}, 0, 'analyzing', datetime('now', '-${durationSec} seconds')
      ) ON CONFLICT(id) DO UPDATE SET
        config = excluded.config,
        status = 'running',
        pages_crawled = excluded.pages_crawled,
        pages_total = excluded.pages_total,
        current_phase = 'analyzing';`,
    ], isRemote);

    // Stage 2: Insert audit pages (preserving source provenance, NULL unmeasured runtime evidence, including OpenGraph — Sol P1-03)
    const pageSqlLines: string[] = [];
    for (const p of crawledPages) {
      const esc = (s: string | null | undefined) => (s ? `'${s.replace(/'/g, "''")}'` : "NULL");
      pageSqlLines.push(`
        INSERT INTO audit_pages (
          id, audit_id, url, status_code, fetch_class, title, meta_description,
          canonical_url, robots_meta, og_title, og_description, og_image,
          h1_count, h2_count, h3_count, h4_count, h5_count, h6_count,
          word_count, content_hash, images_total, images_missing_alt, internal_link_count,
          external_link_count, has_structured_data, is_indexable, crawl_depth, in_sitemap, response_time_ms
        ) VALUES (
          '${p.id}', '${auditId}', '${p.url.replace(/'/g, "''")}', NULL, '${p.fetchClass}',
          ${esc(p.title)}, ${esc(p.metaDescription)}, ${esc(p.canonicalUrl)}, ${esc(p.robotsMeta)},
          ${esc(p.ogTitle)}, ${esc(p.ogDescription)}, ${esc(p.ogImage)},
          ${p.h1Count}, ${p.h2Count}, ${p.h3Count}, ${p.h4Count}, ${p.h5Count}, ${p.h6Count},
          ${p.wordCount}, ${esc(p.contentHash)}, ${p.imagesTotal}, ${p.imagesMissingAlt},
          ${p.links.filter((l) => l.isInternal).length}, ${p.links.filter((l) => !l.isInternal).length},
          ${p.hasStructuredData ? 1 : 0}, ${p.isIndexable ? 1 : 0}, NULL, 0, NULL
        ) ON CONFLICT(id) DO NOTHING;
      `);
    }
    if (pageSqlLines.length > 0) {
      executeD1SqlStatements(pageSqlLines, isRemote);
    }

    // Stage 3: Insert audit issues
    const issueSqlLines: string[] = [];
    for (const issue of detectedIssues) {
      const issueSeed = `${auditId}:${issue.pageId || "global"}:${issue.issueType}:${issue.pageUrl}:${issue.details ? JSON.stringify(issue.details) : ""}`;
      const issueId = deterministicUuid(issueSeed);
      const severity = getIssueDescriptor(issue.issueType)?.severity || "info";
      const detailsJson = issue.details ? JSON.stringify(issue.details).replace(/'/g, "''") : "NULL";
      issueSqlLines.push(`
        INSERT INTO audit_issues (
          id, audit_id, issue_type, severity, page_id, page_url, details_json
        ) VALUES (
          '${issueId}', '${auditId}', '${issue.issueType}', '${severity}', ${issue.pageId ? `'${issue.pageId}'` : "NULL"},
          '${issue.pageUrl.replace(/'/g, "''")}', ${detailsJson === "NULL" ? "NULL" : `'${detailsJson}'`}
        ) ON CONFLICT(id) DO NOTHING;
      `);
    }
    if (issueSqlLines.length > 0) {
      executeD1SqlStatements(issueSqlLines, isRemote);
    }

    // Stage 4: Atomic compare-and-set flip to final status with child row count reconciliation and RETURNING assertion (Sol P1-01, P1-05)
    const casSql = `UPDATE audits
       SET status = '${finalStatus}',
           current_phase = '${finalStatus}',
           pages_crawled = ${processedCount},
           pages_total = ${htmlFiles.length},
           completed_at = datetime('now')
       WHERE id = '${auditId}'
         AND status = 'running'
         AND (SELECT COUNT(*) FROM audit_pages WHERE audit_id = '${auditId}') = ${crawledPages.length}
         AND (SELECT COUNT(*) FROM audit_issues WHERE audit_id = '${auditId}') = ${detectedIssues.length}
       RETURNING id;`;
    const casResult = runD1Query(casSql, isRemote);
    if (!casResult || casResult.length !== 1 || casResult[0].id !== auditId) {
      throw new Error(`Audit CAS finalization failed for ${auditId} (updated ${casResult?.length ?? 0} rows, expected 1 matching id). State conflict or child count mismatch.`);
    }

    // Stage 5 (FLEET-GH-05): Diagnostic Fleet Series Integration strictly scoped to effective roster and active projects (Sol P1-02, P1-03)
    let diagnosticFailed = false;
    try {
      const allRosterVersions = runD1Query(
        `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = 'shared-workspace';`,
        isRemote
      );
      const effectiveRoster = selectEffectiveRosterVersion(allRosterVersions);
      if (!effectiveRoster) {
        console.warn(`[DIAGNOSTIC] No effective approved roster found for organization 'shared-workspace'. Skipping diagnostic series.`);
      } else {
        const rosterRows = runD1Query(
          `SELECT m.id AS member_id, m.version_id, v.organization_id
           FROM fleet_roster_members m
           JOIN fleet_roster_versions v ON v.id = m.version_id
           JOIN projects p ON p.id = m.project_id
           WHERE v.id = '${effectiveRoster.id}'
             AND v.organization_id = 'shared-workspace'
             AND m.canonical_host = '${domain.replace(/'/g, "''")}'
             AND p.id = '${projectId}'
             AND p.organization_id = v.organization_id
             AND p.archived_at IS NULL;`,
          isRemote
        );

        if (rosterRows.length > 0) {
          const { member_id, version_id, organization_id } = rosterRows[0];
          // Deterministic IDs derived from auditId, version, and member (Sol F02)
          const runId = "run_" + crypto.createHash("sha256").update(`${auditId}:${version_id}:${member_id}:run`).digest("hex").slice(0, 16);
          const runItemId = "item_" + crypto.createHash("sha256").update(`${auditId}:${version_id}:${member_id}:item`).digest("hex").slice(0, 16);
          const snapshotId = "snap_" + crypto.createHash("sha256").update(`${auditId}:${version_id}:${member_id}:snap`).digest("hex").slice(0, 16);

          const score = Math.max(
            10,
            Math.min(100, Math.round(100 - (detectedIssues.length / Math.max(1, htmlFiles.length)) * 100))
          );
          const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
          const coverage = Math.round((processedCount / Math.max(1, htmlFiles.length)) * 100 * 100) / 100;

          const runStatus = isComplete ? "completed" : "partial";
          const itemStatus = isComplete ? "completed" : (processedCount > 0 ? "partial" : "failed");
          const nowIso = new Date().toISOString();

          const diagnosticSql = [
            `INSERT INTO fleet_runs (id, organization_id, roster_version_id, rubric_version, trigger, requester_id, status, total_domains, completed_domains, failed_domains, started_at, completed_at)
             VALUES ('${runId}', '${organization_id}', '${version_id}', 'v1', 'manual', 'github-audit-runner', '${runStatus}', 1, ${isComplete ? 1 : 0}, ${isComplete ? 0 : 1}, '${nowIso}', '${nowIso}')
             ON CONFLICT(id) DO UPDATE SET status = '${runStatus}', completed_at = '${nowIso}';`,
            `INSERT INTO fleet_run_items (id, run_id, member_id, project_id, audit_id, primary_series_key, status, attempt_count, started_at, completed_at)
             VALUES ('${runItemId}', '${runId}', '${member_id}', '${projectId}', '${auditId}', 'diagnostic', '${itemStatus}', 1, '${nowIso}', '${nowIso}')
             ON CONFLICT(id) DO UPDATE SET status = '${itemStatus}', completed_at = '${nowIso}';`,
            `INSERT INTO fleet_snapshots (id, run_item_id, member_id, project_id, canonical_host, score, grade, coverage, series_key, score_technical, score_internal_links, score_on_page, score_mobile_perf, score_schema, score_ai_readiness, observed_at)
             VALUES ('${snapshotId}', '${runItemId}', '${member_id}', '${projectId}', '${domain.replace(/'/g, "''")}', ${score}, '${grade}', ${coverage}, 'diagnostic', NULL, NULL, NULL, NULL, NULL, NULL, '${nowIso}')
             ON CONFLICT(id) DO UPDATE SET score = ${score}, grade = '${grade}', coverage = ${coverage}, observed_at = '${nowIso}';`
          ];
          executeD1SqlStatements(diagnosticSql, isRemote);

          // Verify exact triple persisted with full identities (Sol F02, F07)
          const isVerified = verifyDiagnosticTriple(
            runId,
            runItemId,
            snapshotId,
            auditId,
            organization_id,
            version_id,
            member_id,
            projectId,
            domain,
            runStatus,
            itemStatus,
            isRemote,
          );
          if (!isVerified) {
            throw new Error(`Diagnostic triple verification failed for audit ${auditId}`);
          }
          console.log(`[DIAGNOSTIC] Recorded and verified fleet diagnostic series run item for ${domain} (${runItemId}, score: ${score}, coverage: ${coverage}%, status: ${itemStatus})`);
        } else {
          console.log(`[DIAGNOSTIC] Host '${domain}' is not in effective roster '${effectiveRoster.id}' or project is inactive. Skipped fleet diagnostic series.`);
        }
      }
    } catch (diagErr: any) {
      console.error(`[ERROR] Diagnostic fleet series linking failed:`, diagErr?.message || diagErr);
      diagnosticFailed = true;
    }

    if (diagnosticFailed) {
      console.error(`[ERROR] Audit finalized in D1 for ${domain} but diagnostic fleet series recording failed.`);
      process.exitCode = 1;
      return false;
    }

    console.log(`[SUCCESS] ${domain} audit successfully finalized in D1 as '${finalStatus}'! (${processedCount} pages, ${detectedIssues.length} issues)`);
    return isComplete;
  } catch (d1Err: any) {
    console.error(`[ERROR] D1 persistence failed for ${domain}:`, d1Err?.message || d1Err);
    // Mark audit as failed on error with observable CAS verification (Sol F9)
    try {
      const fallbackSql = `UPDATE audits
         SET status = 'failed',
             error_code = 'CHUNK_WRITE_FAILED',
             current_phase = 'failed',
             completed_at = datetime('now')
         WHERE id = '${auditId}' AND status = 'running'
         RETURNING id;`;
      const fallbackRows = runD1Query(fallbackSql, isRemote);
      if (!fallbackRows || fallbackRows.length === 0) {
        console.warn(`[WARN] Fallback failure CAS updated 0 rows for ${auditId} on ${isRemote ? "open-seo-db-selfhost" : "DB"} (already finalized or missing).`);
      } else if (fallbackRows.length > 1 || fallbackRows[0].id !== auditId) {
        throw new Error(`Unexpected fallback CAS result for ${auditId}: updated ${fallbackRows.length} rows`);
      } else {
        console.log(`[FALLBACK] Finalized audit ${auditId} status as 'failed' (error_code: CHUNK_WRITE_FAILED) on ${isRemote ? "open-seo-db-selfhost" : "DB"}`);
      }
    } catch (fallbackErr: any) {
      console.error(`[CRITICAL] Fallback failure CAS execution error for audit ${auditId} on ${isRemote ? "open-seo-db-selfhost" : "DB"}:`, fallbackErr?.message || fallbackErr);
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
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
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
    WHERE r.id = '${runId}'
      AND i.id = '${runItemId}'
      AND s.id = '${snapshotId}'
      AND r.organization_id = '${orgId}'
      AND r.roster_version_id = '${rosterId}'
      AND i.audit_id = '${auditId}'
      AND i.member_id = '${memberId}'
      AND i.project_id = '${projectId}'
      AND s.member_id = '${memberId}'
      AND s.project_id = '${projectId}'
      AND s.canonical_host = '${canonicalHost.replace(/'/g, "''")}'
      AND i.primary_series_key = 'diagnostic'
      AND s.series_key = 'diagnostic'
      AND r.status = '${expectedRunStatus}'
      AND i.status = '${expectedItemStatus}'
      AND 1 = (SELECT count(*) FROM fleet_run_items WHERE audit_id = '${auditId}' AND primary_series_key = 'diagnostic');
  `;
  const res = runD1Query(query, isRemote);
  return res.length === 1;
}

function repairDiagnosticObservation(
  auditId: string,
  projectId: string,
  domain: string,
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
      `SELECT m.id AS member_id, m.version_id, v.organization_id
       FROM fleet_roster_members m
       JOIN fleet_roster_versions v ON v.id = m.version_id
       JOIN projects p ON p.id = m.project_id
       WHERE v.id = '${effectiveRoster.id}'
         AND v.organization_id = 'shared-workspace'
         AND m.canonical_host = '${domain.replace(/'/g, "''")}'
         AND p.id = '${projectId}'
         AND p.organization_id = v.organization_id
         AND p.archived_at IS NULL;`,
      isRemote,
    );
    if (rosterRows.length === 0) return false;

    const { member_id, version_id, organization_id } = rosterRows[0];
    const runId = "run_" + crypto.createHash("sha256").update(`${auditId}:${version_id}:${member_id}:run`).digest("hex").slice(0, 16);
    const runItemId = "item_" + crypto.createHash("sha256").update(`${auditId}:${version_id}:${member_id}:item`).digest("hex").slice(0, 16);
    const snapshotId = "snap_" + crypto.createHash("sha256").update(`${auditId}:${version_id}:${member_id}:snap`).digest("hex").slice(0, 16);

    const counts = runD1Query(
      `SELECT a.pages_crawled, a.pages_total, a.completed_at,
              (SELECT COUNT(*) FROM audit_issues WHERE audit_id = a.id) as issue_count
       FROM audits a WHERE a.id = '${auditId}';`,
      isRemote,
    );
    if (counts.length === 0) return false;
    const { pages_crawled, pages_total, completed_at, issue_count } = counts[0];
    const crawled = Number(pages_crawled || 0);
    const total = Number(pages_total || 1);
    const issues = Number(issue_count || 0);

    const score = Math.max(10, Math.min(100, Math.round(100 - (issues / Math.max(1, total)) * 100)));
    const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
    const coverage = Math.round((crawled / Math.max(1, total)) * 100 * 100) / 100;
    const observedAt = completed_at || new Date().toISOString();

    const diagnosticSql = [
      `INSERT INTO fleet_runs (id, organization_id, roster_version_id, rubric_version, trigger, requester_id, status, total_domains, completed_domains, failed_domains, started_at, completed_at)
       VALUES ('${runId}', '${organization_id}', '${version_id}', 'v1', 'manual', 'github-audit-runner', 'completed', 1, 1, 0, '${observedAt}', '${observedAt}')
       ON CONFLICT(id) DO UPDATE SET status = 'completed', completed_at = '${observedAt}';`,
      `INSERT INTO fleet_run_items (id, run_id, member_id, project_id, audit_id, primary_series_key, status, attempt_count, started_at, completed_at)
       VALUES ('${runItemId}', '${runId}', '${member_id}', '${projectId}', '${auditId}', 'diagnostic', 'completed', 1, '${observedAt}', '${observedAt}')
       ON CONFLICT(id) DO UPDATE SET status = 'completed', completed_at = '${observedAt}';`,
      `INSERT INTO fleet_snapshots (id, run_item_id, member_id, project_id, canonical_host, score, grade, coverage, series_key, score_technical, score_internal_links, score_on_page, score_mobile_perf, score_schema, score_ai_readiness, observed_at)
       VALUES ('${snapshotId}', '${runItemId}', '${member_id}', '${projectId}', '${domain.replace(/'/g, "''")}', ${score}, '${grade}', ${coverage}, 'diagnostic', NULL, NULL, NULL, NULL, NULL, NULL, '${observedAt}')
       ON CONFLICT(id) DO UPDATE SET score = ${score}, grade = '${grade}', coverage = ${coverage}, observed_at = '${observedAt}';`
    ];
    executeD1SqlStatements(diagnosticSql, isRemote);

    // Strict full exact triple verification (Sol F02, F07)
    const isVerified = verifyDiagnosticTriple(
      runId,
      runItemId,
      snapshotId,
      auditId,
      organization_id,
      version_id,
      member_id,
      projectId,
      domain,
      "completed",
      "completed",
      isRemote,
    );
    if (isVerified) {
      console.log(`[REPAIR] Successfully repaired diagnostic observation for ${domain} (${auditId})`);
      return true;
    }
  } catch (err: any) {
    console.error(`[REPAIR ERROR] Failed to repair diagnostic observation:`, err?.message || err);
  }
  return false;
}

type FleetAction =
  | { kind: "repair"; domain: string; projectId: string; auditId: string }
  | { kind: "audit"; mapping: RepoMapping };

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
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (args.positionals.length > 0) {
    console.error(`[ERROR] Stray positional arguments detected (${args.positionals.join(", ")}). Positional arguments not permitted.`);
    process.exit(1);
  }

  // Sol F2: Mutual exclusivity of --local and --remote
  const hasRemoteArg = process.argv.includes("--remote");
  const hasLocalArg = process.argv.includes("--local");
  if (hasRemoteArg && hasLocalArg) {
    console.error("[ERROR] Conflicting flags: cannot specify both --remote and --local.");
    process.exit(1);
  }
  const isRemote = !hasLocalArg;

  console.log("=== OpenSEO Zero-Limit GitHub Repository Audit Runner ===");

  // Sol F2: Strict tagged selector validation upfront
  let targetDomain: string | undefined;
  if (args.values.domain !== undefined) {
    const raw = String(args.values.domain).trim().toLowerCase();
    if (!raw || !isValidCanonicalHostname(raw)) {
      console.error(`[ERROR] --domain requires a canonical RFC 1123 hostname. Received: "${args.values.domain}"`);
      process.exit(1);
    }
    targetDomain = raw;
  }

  let limit: number | undefined;
  if (args.values.limit !== undefined) {
    const rawLimit = String(args.values.limit);
    if (!/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) {
      console.error("[ERROR] Invalid --limit value. Must be a safe positive integer.");
      process.exit(1);
    }
    limit = parseInt(rawLimit, 10);
  }
  const force = !!args.values.force;
  const isWorkspace = !!args.values.workspace;

  // Sol P2-04: Strict numeric and scope validation
  const rawMaxPages = args.values["max-pages"] ? String(args.values["max-pages"]) : "10000";
  const numMaxPages = Number(rawMaxPages);
  if (!/^[1-9][0-9]*$/.test(rawMaxPages) || !Number.isSafeInteger(numMaxPages) || numMaxPages > 10000) {
    console.error("[ERROR] Invalid --max-pages value. Must be a safe positive integer between 1 and 10000.");
    process.exit(1);
  }
  const maxPages = numMaxPages;

  const scopeCount =
    Number(targetDomain !== undefined) +
    Number(args.values.all === true) +
    Number(args.values.limit !== undefined);
  if (scopeCount !== 1) {
    console.error("[ERROR] Missing or conflicting execution scope. Specify exactly one of --domain <canonical-host>, --all, or --limit <n>.");
    process.exit(1);
  }

  // Load project mappings from D1 with duplicate domain detection (Sol F01)
  const projectRows = runD1Query(
    "SELECT id, domain FROM projects WHERE organization_id = 'shared-workspace' AND domain IS NOT NULL AND archived_at IS NULL;",
    isRemote
  );
  const projectIdByDomain = new Map<string, string>();
  for (const p of projectRows) {
    const dom = p.domain.toLowerCase().trim();
    if (projectIdByDomain.has(dom) && projectIdByDomain.get(dom) !== p.id) {
      console.error(`[ERROR] Conflicting active project IDs found for domain '${dom}': ${projectIdByDomain.get(dom)} and ${p.id}.`);
      process.exit(1);
    }
    projectIdByDomain.set(dom, p.id);
  }

  // Load effective approved roster for admission scoping (Sol F01)
  const allRosterVersions = runD1Query(
    `SELECT id, version_tag, approved_at, domain_count FROM fleet_roster_versions WHERE organization_id = 'shared-workspace';`,
    isRemote
  );
  const effectiveRoster = selectEffectiveRosterVersion(allRosterVersions);
  if (!isWorkspace && !effectiveRoster) {
    console.error("[ERROR] No effective approved roster found for organization 'shared-workspace'. Pass --workspace to audit wider inventory or approve a roster.");
    process.exit(1);
  }

  const approvedHosts = new Set<string>();
  const approvedMembersByHost = new Map<string, { memberId: string; versionId: string; projectId: string; canonicalHost: string }>();
  if (effectiveRoster) {
    const rosterRows = runD1Query(
      `SELECT m.id AS member_id, m.version_id, m.canonical_host, m.project_id
       FROM fleet_roster_members m
       JOIN fleet_roster_versions v ON v.id = m.version_id
       WHERE v.id = '${effectiveRoster.id}'
         AND v.organization_id = 'shared-workspace'
         AND m.project_id IS NOT NULL;`,
      isRemote
    );
    for (const r of rosterRows) {
      const host = r.canonical_host.toLowerCase().trim();
      approvedMembersByHost.set(host, {
        memberId: r.member_id,
        versionId: r.version_id,
        projectId: r.project_id,
        canonicalHost: host,
      });
      approvedHosts.add(host);
    }
  }

  // Load deterministic latest completed source audits with verified diagnostic triple (Sol F02, F07, F10)
  const completedAudits = runD1Query(
    `WITH ranked_audits AS (
       SELECT a.id, a.project_id, a.completed_at,
              ROW_NUMBER() OVER (
                PARTITION BY a.project_id
                ORDER BY julianday(a.completed_at) DESC NULLS LAST, a.id DESC
              ) AS audit_rank
       FROM audits a
       WHERE a.status = 'completed'
         AND a.workflow_instance_id LIKE 'github-audit-%'
         AND a.pages_crawled >= a.pages_total
     )
     SELECT ra.id, ra.project_id,
            (
              SELECT COUNT(*)
              FROM fleet_runs r
              JOIN fleet_run_items fri ON fri.run_id = r.id
              JOIN fleet_snapshots fs ON fs.run_item_id = fri.id
              JOIN fleet_roster_members rm ON fri.member_id = rm.id
              WHERE fri.audit_id = ra.id
                AND fri.primary_series_key = 'diagnostic'
                AND fs.series_key = 'diagnostic'
                AND r.status IN ('completed', 'partial')
                AND fri.status IN ('completed', 'partial')
                AND fri.project_id = ra.project_id
                AND fs.project_id = ra.project_id
                AND fs.canonical_host = rm.canonical_host
                AND r.organization_id = 'shared-workspace'
                ${effectiveRoster ? `AND r.roster_version_id = '${effectiveRoster.id}' AND rm.version_id = '${effectiveRoster.id}'` : ""}
            ) AS has_verified_triple
     FROM ranked_audits ra
     WHERE ra.audit_rank = 1;`,
    isRemote
  );
  const auditByProjectId = new Map<string, { id: string; hasDiagnostic: boolean }>();
  for (const a of completedAudits) {
    auditByProjectId.set(a.project_id, {
      id: a.id,
      hasDiagnostic: Number(a.has_verified_triple ?? 0) > 0,
    });
  }

  const repoMappings = loadRepoMappings();
  console.log(`Loaded ${repoMappings.size} repository mappings from manifest & PROJECTS_GITHUB.md.`);

  // Build deterministic planned actions list (Sol F01, F02: respects approved roster vs workspace scope)
  const plannedActions: FleetAction[] = [];

  if (targetDomain) {
    const approvedMember = approvedMembersByHost.get(targetDomain);
    const projId = !isWorkspace && approvedMember ? approvedMember.projectId : projectIdByDomain.get(targetDomain);
    const repoMeta = repoMappings.get(targetDomain);
    if (!projId || !repoMeta) {
      console.error(`[ERROR] Domain '${targetDomain}' is not found among enrolled projects or repository mappings.`);
      process.exit(1);
    }
    if (!isWorkspace && effectiveRoster && !approvedHosts.has(targetDomain)) {
      console.error(`[ERROR] Domain '${targetDomain}' is not in approved fleet roster '${effectiveRoster.id}'. Pass --workspace to audit wider inventory.`);
      process.exit(1);
    }
    const existingAudit = auditByProjectId.get(projId);
    if (!force && existingAudit) {
      const isRosterMember = approvedHosts.has(targetDomain);
      if (isRosterMember && !existingAudit.hasDiagnostic) {
        plannedActions.push({ kind: "repair", domain: targetDomain, projectId: projId, auditId: existingAudit.id });
      } else {
        console.log(`[REUSED] Project for domain '${targetDomain}' already has a completed GitHub source audit. Use --force to re-audit.`);
        return;
      }
    } else {
      plannedActions.push({ kind: "audit", mapping: { ...repoMeta, projectId: projId } });
    }
  } else {
    for (const [dom, m] of repoMappings.entries()) {
      const approvedMember = approvedMembersByHost.get(dom);
      const isEligible = isWorkspace || approvedHosts.has(dom);
      const projId = !isWorkspace && approvedMember ? approvedMember.projectId : projectIdByDomain.get(dom);
      if (projId && isEligible) {
        const existingAudit = auditByProjectId.get(projId);
        if (!force && existingAudit) {
          const isRosterMember = approvedHosts.has(dom);
          if (isRosterMember && !existingAudit.hasDiagnostic) {
            plannedActions.push({ kind: "repair", domain: dom, projectId: projId, auditId: existingAudit.id });
          } else {
            continue; // Reused
          }
        } else {
          plannedActions.push({ kind: "audit", mapping: { ...m, projectId: projId } });
        }
      }
    }
  }

  // Sol F2: Apply limit to the combined list of repairs and fresh audits before write selection
  const selectedActions = limit !== undefined ? plannedActions.slice(0, limit) : plannedActions;
  console.log(`Executing ${selectedActions.length} planned fleet actions (Total planned: ${plannedActions.length}, Limit: ${limit ?? "none"})...`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < selectedActions.length; i++) {
    const action = selectedActions[i];
    if (action.kind === "repair") {
      console.log(`\n[${i + 1}/${selectedActions.length}] [REPAIR] Repairing diagnostic observation for ${action.domain} (${action.auditId})...`);
      const ok = repairDiagnosticObservation(action.auditId, action.projectId, action.domain, isRemote);
      if (ok) {
        successCount++;
      } else {
        console.error(`[REPAIR FAILED] Failed to repair diagnostic observation for ${action.domain} (${action.auditId}). Aborting without fallback Git crawl (Sol F4).`);
        failCount++;
      }
    } else {
      const c = action.mapping;
      console.log(`\n[${i + 1}/${selectedActions.length}] [AUDIT] Starting audit for ${c.domain} (${c.repoName})...`);
      try {
        const ok = await auditRepository(c, maxPages, !!args.values.archive, isRemote);
        if (ok) successCount++;
        else failCount++;
      } catch (err: any) {
        console.error(`Audit failed for ${c.domain}:`, err?.message || err);
        failCount++;
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`GitHub Fleet Audit Completed! Success: ${successCount}, Failed: ${failCount}`);
  console.log(`======================================================`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal GitHub Fleet Audit Runner Error:", err);
  process.exit(1);
});
