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
  const sanitized = query.replace(/\r?\n/g, " ").trim();
  const dbName = isRemote ? "open-seo-db-selfhost" : "DB";
  const flag = isRemote ? "--remote" : "--local";
  const cmd = `npx wrangler d1 execute ${dbName} ${flag} --json --command "${sanitized.replace(/"/g, '\\"')}"`;
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

function executeD1SqlStatements(sqlLines: string[], isRemote = true): void {
  const dbName = isRemote ? "open-seo-db-selfhost" : "DB";
  const flag = isRemote ? "--remote" : "--local";
  const CHUNK_SIZE = 500;
  for (let i = 0; i < sqlLines.length; i += CHUNK_SIZE) {
    const chunk = sqlLines.slice(i, i + CHUNK_SIZE).join("\n");
    const scratchDir = resolve("C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/scratch");
    if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true });
    const tempFile = resolve(scratchDir, `batch_${Date.now()}_${i}.sql`);
    writeFileSync(tempFile, chunk, "utf8");
    try {
      const cmd = `npx wrangler d1 execute ${dbName} ${flag} --file "${tempFile}"`;
      execSync(cmd, {
        cwd: "C:/Users/THINKPAD/Documents/GitHub/seo.codev.id",
        env: { ...process.env, ...envVars },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {}
    }
  }
}

interface RepoMapping {
  domain: string;
  repoName: string;
  projectId?: string;
}

function loadRepoMappings(): Map<string, RepoMapping> {
  const map = new Map<string, RepoMapping>();

  // 1. Load from fleetManifest.json (canonical approved mappings take highest precedence)
  try {
    const raw = readFileSync(FLEET_MANIFEST_FILE, "utf8");
    const list = JSON.parse(raw);
    for (const item of list) {
      if (item.canonicalHost && item.repoName) {
        map.set(item.canonicalHost.toLowerCase().trim(), {
          domain: item.canonicalHost.toLowerCase().trim(),
          repoName: item.repoName.trim(),
        });
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
        if (owner && repo && site && !map.has(site)) {
          map.set(site, { domain: site, repoName: `${owner}/${repo}` });
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

/**
 * In-memory zero-disk tarball parser for gzipped ustar archives (FLEET-GH-02).
 * Bounds entry size to 5MB and extracts regular HTML files under the repository root into raw Buffers.
 */
function parseTarHtmlFiles(
  tarBuf: Buffer,
  maxEntrySize = 5 * 1024 * 1024,
): Map<string, Buffer> {
  const htmlMap = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);

    let isAllZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) break;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;

    const slashIdx = fullName.indexOf("/");
    const relPath = slashIdx !== -1 ? fullName.slice(slashIdx + 1) : fullName;

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8);

    const typeFlag = header[156];
    const isRegularFile = typeFlag === 0 || typeFlag === 48;

    const contentStart = offset + 512;
    const contentEnd = contentStart + (isNaN(size) ? 0 : size);

    if (
      isRegularFile &&
      !isNaN(size) &&
      size <= maxEntrySize &&
      (relPath.endsWith(".html") || relPath.endsWith(".htm"))
    ) {
      if (contentEnd <= tarBuf.length) {
        const content = Buffer.from(tarBuf.subarray(contentStart, contentEnd));
        htmlMap.set(relPath, content);
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset += 512 + (isNaN(paddedSize) ? 512 : paddedSize);
  }

  return htmlMap;
}

async function auditRepository(mapping: RepoMapping, maxPages = 10000, useArchive = false, isRemote = true): Promise<boolean> {
  const { domain, repoName, projectId } = mapping;
  console.log(`\n======================================================`);
  console.log(`Auditing ${domain} directly from GitHub repo ${repoName}`);
  console.log(`======================================================`);

  // 1. Resolve default branch and immutable commit SHA
  let defaultBranch = "main";
  let commitSha = "";
  let treeItems: Array<{ path: string; mode: string; type: string; sha: string; size?: number }> = [];
  let isTreeTruncated = false;

  try {
    const repoInfo = JSON.parse(
      execSync(`gh api /repos/${repoName}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
    );
    defaultBranch = repoInfo.default_branch || "main";

    const commitInfo = JSON.parse(
      execSync(`gh api /repos/${repoName}/commits/${defaultBranch}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
    );
    commitSha = commitInfo.sha;
    console.log(`Pinned commit: ${commitSha.slice(0, 10)} (branch: ${defaultBranch})`);

    const treeJson = execSync(
      `gh api /repos/${repoName}/git/trees/${commitSha}?recursive=1`,
      { encoding: "utf8", maxBuffer: 30 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
    );
    const parsedTree = JSON.parse(treeJson);
    if (parsedTree.truncated) {
      isTreeTruncated = true;
      throw new Error(`Git tree for ${repoName} is truncated by GitHub (exceeds limit); recursive subtree enumeration required`);
    }
    treeItems = parsedTree.tree || [];
  } catch (err: any) {
    console.error(`Failed to fetch git tree for ${repoName}:`, err?.message || err);
    return false;
  }

  // 2. Build comprehensive route set from ALL tree items (pages + static assets)
  const validRouteSet = new Set<string>();
  const htmlFiles: typeof treeItems = [];

  for (const item of treeItems) {
    if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755")) continue;
    const p = item.path;
    const isHtml = p.endsWith(".html") || p.endsWith(".htm");

    if (isHtml) {
      htmlFiles.push(item);
    }

    // Direct path
    validRouteSet.add(normalizeRoute(`${domain}/${p}`));

    if (isHtml) {
      if (p === "index.html" || p === "index.htm") {
        validRouteSet.add(normalizeRoute(domain));
      } else if (p.endsWith("/index.html")) {
        const slug = p.slice(0, -11);
        validRouteSet.add(normalizeRoute(`${domain}/${slug}`));
      } else if (p.endsWith("/index.htm")) {
        const slug = p.slice(0, -10);
        validRouteSet.add(normalizeRoute(`${domain}/${slug}`));
      } else if (p.endsWith(".html")) {
        const slug = p.slice(0, -5);
        validRouteSet.add(normalizeRoute(`${domain}/${slug}`));
      } else if (p.endsWith(".htm")) {
        const slug = p.slice(0, -4);
        validRouteSet.add(normalizeRoute(`${domain}/${slug}`));
      }
    }
  }

  console.log(`Discovered ${htmlFiles.length} static HTML pages and ${treeItems.length} total repository assets in ${repoName}`);
  if (htmlFiles.length === 0) {
    console.warn(`No HTML pages found in repository ${repoName}. Skipping.`);
    return false;
  }

  const candidateFiles = htmlFiles.slice(0, maxPages);

  // Helper to map repo path to public page URL using canonical served identities (Sol Snippet 3)
  const pathToUrl = (path: string): string => {
    const segments = path.split("/").map(encodeURIComponent);
    const isDirectoryIndex = /^(?:index\.html|index\.htm)$/i.test(segments.at(-1) ?? "");
    if (isDirectoryIndex) segments.pop();
    const pathname = "/" + segments.join("/") + (isDirectoryIndex && segments.length ? "/" : "");
    return `https://${domain}${pathname}`;
  };

  // Build bidirectional alias-to-canonical route map to eliminate false orphan reports (Sol P1-03)
  const aliasToCanonicalUrl = new Map<string, string>();
  for (const file of htmlFiles) {
    const canonical = pathToUrl(file.path);
    const normCanonical = normalizeRoute(canonical);
    aliasToCanonicalUrl.set(normCanonical, canonical);

    // Direct path aliases (/docs/index.html -> /docs/)
    aliasToCanonicalUrl.set(normalizeRoute(`https://${domain}/${file.path}`), canonical);
    aliasToCanonicalUrl.set(normalizeRoute(`/${file.path}`), canonical);

    if (file.path === "index.html" || file.path === "index.htm") {
      aliasToCanonicalUrl.set(normalizeRoute(domain), canonical);
      aliasToCanonicalUrl.set(normalizeRoute("/"), canonical);
    } else if (file.path.endsWith("/index.html")) {
      const dirSlug = file.path.slice(0, -11);
      aliasToCanonicalUrl.set(normalizeRoute(`https://${domain}/${dirSlug}`), canonical);
      aliasToCanonicalUrl.set(normalizeRoute(`/${dirSlug}`), canonical);
      aliasToCanonicalUrl.set(normalizeRoute(`/${dirSlug}/`), canonical);
    } else if (file.path.endsWith("/index.htm")) {
      const dirSlug = file.path.slice(0, -10);
      aliasToCanonicalUrl.set(normalizeRoute(`https://${domain}/${dirSlug}`), canonical);
      aliasToCanonicalUrl.set(normalizeRoute(`/${dirSlug}`), canonical);
      aliasToCanonicalUrl.set(normalizeRoute(`/${dirSlug}/`), canonical);
    }
  }

  // 3. Fetch and analyze HTML files with paced concurrency
  const auditId = crypto.randomUUID();
  const startTime = Date.now();
  const crawledPages: CrawledPageResult[] = [];
  const detectedIssues: DetectedIssue[] = [];
  const inboundLinkCounts = new Map<string, number>();

  let archiveHtmlMap: Map<string, Buffer> | null = null;
  if (useArchive) {
    try {
      console.log(`[ARCHIVE] In-process streaming commit-pinned tarball for ${repoName} (${commitSha.slice(0, 10)})...`);
      const tarUrl = `https://codeload.github.com/${repoName}/legacy.tar.gz/${commitSha}`;
      const res = await fetch(tarUrl, {
        headers: {
          ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
          "User-Agent": "OpenSEO-Audit",
        },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching archive from codeload`);
      }
      const arrayBuf = await res.arrayBuffer();
      const tarBuf = Buffer.from(arrayBuf);
      if (tarBuf.length > 100 * 1024 * 1024) {
        throw new Error(`Archive exceeds 100MB bound (${tarBuf.length} bytes)`);
      }
      const decompressed = zlib.gunzipSync(tarBuf, { maxOutputLength: 250 * 1024 * 1024 });
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
          let bytes: Buffer | null = null;
          if (archiveHtmlMap && archiveHtmlMap.has(file.path)) {
            bytes = archiveHtmlMap.get(file.path)!;
          } else {
            const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
            const rawUrl = `https://raw.githubusercontent.com/${repoName}/${commitSha}/${encodedPath}`;
            const res = await fetch(rawUrl, {
              headers: {
                ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
                "User-Agent": "OpenSEO-GitHub-Audit-Engine",
              },
            });

            if (!res.ok) {
              console.warn(`Failed to fetch ${file.path}: HTTP ${res.status}`);
              return;
            }

            const arrayBuf = await res.arrayBuffer();
            bytes = Buffer.from(arrayBuf);
          }

          if (!bytes) return;

          // Cryptographic Git Blob Identity Verification (Sol P1 - F1)
          const algorithm = file.sha.length === 64 ? "sha256" : "sha1";
          const blobId = crypto.createHash(algorithm)
            .update("blob " + bytes.length + "\0")
            .update(bytes)
            .digest("hex");
          if (blobId !== file.sha) {
            throw new Error(`Git blob identity mismatch for ${file.path}: expected ${file.sha}, got ${blobId}`);
          }

          const html = bytes.toString("utf8");
          const analysis = analyzeHtml(html, pageUrl, 200, 50);

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

          // Check internal links against known repository routes using URL resolution (Sol Snippet 3 & P1-03)
          for (const link of analysis.links) {
            if (link.isInternal && link.targetUrl) {
              try {
                const servedUrl = new URL(pageUrl);
                const target = new URL(link.targetUrl, servedUrl);
                if (target.origin === servedUrl.origin) {
                  const normTarget = normalizeRoute(`https://${domain}${target.pathname}`);
                  const normPageUrl = normalizeRoute(pageUrl);
                  const destCanonical = aliasToCanonicalUrl.get(normTarget) || normTarget;
                  const sourceCanonical = aliasToCanonicalUrl.get(normPageUrl) || normPageUrl;

                  if (destCanonical && destCanonical !== sourceCanonical) {
                    if (validRouteSet.has(normTarget) || aliasToCanonicalUrl.has(normTarget)) {
                      inboundLinkCounts.set(destCanonical, (inboundLinkCounts.get(destCanonical) || 0) + 1);
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

  // 4. Detect Orphan Pages (only when tree is complete and all eligible pages read — Sol P1-03)
  const homeNorm = normalizeRoute(domain);
  if (isComplete && unreadCount === 0) {
    for (const page of crawledPages) {
      if (normalizeRoute(page.url) === homeNorm) continue;
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
      );`,
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
      const issueId = crypto.randomUUID();
      const severity = getIssueDescriptor(issue.issueType)?.severity || "info";
      const detailsJson = issue.details ? JSON.stringify(issue.details).replace(/'/g, "''") : "NULL";
      issueSqlLines.push(`
        INSERT INTO audit_issues (
          id, audit_id, issue_type, severity, page_id, page_url, details_json
        ) VALUES (
          '${issueId}', '${auditId}', '${issue.issueType}', '${severity}', ${issue.pageId ? `'${issue.pageId}'` : "NULL"},
          '${issue.pageUrl.replace(/'/g, "''")}', ${detailsJson === "NULL" ? "NULL" : `'${detailsJson}'`}
        );
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
    if (!casResult || casResult.length !== 1) {
      throw new Error(`Audit CAS finalization failed for ${auditId} (updated ${casResult?.length ?? 0} rows, expected 1). State conflict or child count mismatch.`);
    }

    // Stage 5 (FLEET-GH-05): Diagnostic Fleet Series Integration strictly scoped to organization and approved roster (Sol P1-02, P1-06)
    try {
      const rosterRows = runD1Query(
        `SELECT m.id AS member_id, m.version_id, v.organization_id
         FROM fleet_roster_members m
         JOIN fleet_roster_versions v ON v.id = m.version_id
         JOIN projects p ON p.id = m.project_id
         WHERE m.canonical_host = '${domain.replace(/'/g, "''")}'
           AND m.project_id = '${projectId}'
           AND p.organization_id = 'shared-workspace'
           AND v.organization_id = 'shared-workspace'
         ORDER BY v.approved_at DESC LIMIT 1;`,
        isRemote
      );

      if (rosterRows.length > 0) {
        const { member_id, version_id, organization_id } = rosterRows[0];
        const runId = "run_" + crypto.randomBytes(8).toString("hex");
        const runItemId = "item_" + crypto.randomBytes(8).toString("hex");
        const snapshotId = "snap_" + crypto.randomBytes(8).toString("hex");

        const score = Math.max(
          10,
          Math.min(100, Math.round(100 - (detectedIssues.length / Math.max(1, htmlFiles.length)) * 100))
        );
        const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
        const coverage = Math.round((processedCount / Math.max(1, htmlFiles.length)) * 100);

        const diagnosticSql = [
          `INSERT INTO fleet_runs (id, organization_id, roster_version_id, rubric_version, trigger, requester_id, status, total_domains, completed_domains, failed_domains, started_at, completed_at)
           VALUES ('${runId}', '${organization_id}', '${version_id}', 'v1', 'manual', 'github-audit-runner', '${isComplete ? "completed" : "failed"}', 1, ${isComplete ? 1 : 0}, ${isComplete ? 0 : 1}, datetime('now'), datetime('now'));`,
          `INSERT INTO fleet_run_items (id, run_id, member_id, project_id, audit_id, primary_series_key, status, attempt_count, started_at, completed_at)
           VALUES ('${runItemId}', '${runId}', '${member_id}', '${projectId}', '${auditId}', 'diagnostic', '${isComplete ? "completed" : "partial"}', 1, datetime('now'), datetime('now'));`,
          `INSERT INTO fleet_snapshots (id, run_item_id, member_id, project_id, canonical_host, score, grade, coverage, series_key, score_technical, score_internal_links, score_on_page, score_mobile_perf, score_schema, score_ai_readiness, observed_at)
           VALUES ('${snapshotId}', '${runItemId}', '${member_id}', '${projectId}', '${domain.replace(/'/g, "''")}', ${score}, '${grade}', ${coverage}, 'diagnostic', ${score}, NULL, ${score}, NULL, NULL, NULL, datetime('now'));`
        ];
        executeD1SqlStatements(diagnosticSql, isRemote);
        console.log(`[DIAGNOSTIC] Recorded fleet diagnostic series run item for ${domain} (${runItemId}, score: ${score}, coverage: ${coverage}%)`);
      }
    } catch (diagErr: any) {
      console.error(`[ERROR] Diagnostic fleet series linking failed:`, diagErr?.message || diagErr);
    }

    console.log(`[SUCCESS] ${domain} audit successfully finalized in D1 as '${finalStatus}'! (${processedCount} pages, ${detectedIssues.length} issues)`);
    return isComplete;
  } catch (d1Err: any) {
    console.error(`[ERROR] D1 persistence failed for ${domain}:`, d1Err?.message || d1Err);
    // Mark audit as failed on error
    try {
      const fallbackRows = runD1Query(
        `UPDATE audits
         SET status = 'failed',
             error_code = 'CHUNK_WRITE_FAILED',
             current_phase = 'failed',
             completed_at = datetime('now')
         WHERE id = '${auditId}' AND status = 'running'
         RETURNING id;`,
        isRemote,
      );
      if (!fallbackRows || fallbackRows.length === 0) {
        console.warn(`[WARN] Fallback failure CAS updated 0 rows for ${auditId} (already finalized or missing).`);
      }
    } catch {}
    return false;
  }
}

async function main() {
  const args = parseArgs({
    options: {
      domain: { type: "string", short: "d" },
      limit: { type: "string", short: "l" },
      all: { type: "boolean", short: "a" },
      force: { type: "boolean", short: "f" },
      archive: { type: "boolean" },
      "max-pages": { type: "string", short: "m", default: "10000" },
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  console.log("=== OpenSEO Zero-Limit GitHub Repository Audit Runner ===");
  const targetDomain = args.values.domain?.toLowerCase().trim();
  const isRemote = !args.values.local;
  let limit: number | undefined;
  if (args.values.limit) {
    if (!/^[1-9][0-9]*$/.test(args.values.limit)) {
      console.error("[ERROR] Invalid --limit value. Must be a positive integer.");
      process.exit(1);
    }
    limit = parseInt(args.values.limit, 10);
  }
  const force = !!args.values.force;
  const isAll = !!args.values.all;
  const rawMaxPages = parseInt(args.values["max-pages"] || "10000", 10);
  const maxPages = Number.isFinite(rawMaxPages) && rawMaxPages > 0 ? rawMaxPages : 10000;

  // Sol P1-2: Require explicit execution scope (fail closed against unintended global audits)
  if (!targetDomain && !isAll && !limit) {
    console.error("[ERROR] Missing explicit execution scope. Please specify --domain <canonical-host>, --all, or --limit <n>.");
    process.exit(1);
  }

  // Load project mappings from D1
  const projectRows = runD1Query(
    "SELECT id, domain FROM projects WHERE organization_id = 'shared-workspace' AND domain IS NOT NULL AND archived_at IS NULL;",
    isRemote
  );
  const projectIdByDomain = new Map<string, string>();
  for (const p of projectRows) {
    projectIdByDomain.set(p.domain.toLowerCase().trim(), p.id);
  }

  // Load truly completed audits from github source engine to avoid redundant work unless --force is given (Sol P1-01)
  const completedAudits = runD1Query(
    "SELECT DISTINCT project_id FROM audits WHERE status = 'completed' AND workflow_instance_id LIKE 'github-audit-%' AND pages_crawled >= pages_total;",
    isRemote
  );
  const alreadyAuditedProjectIds = new Set(completedAudits.map((a) => a.project_id));

  const repoMappings = loadRepoMappings();
  console.log(`Loaded ${repoMappings.size} repository mappings from manifest & PROJECTS_GITHUB.md.`);

  let candidates: RepoMapping[] = [];
  if (targetDomain) {
    const projId = projectIdByDomain.get(targetDomain);
    const repoMeta = repoMappings.get(targetDomain);
    if (!projId || !repoMeta) {
      console.error(`[ERROR] Domain '${targetDomain}' is not found among enrolled projects or repository mappings.`);
      process.exit(1);
    }
    if (!force && alreadyAuditedProjectIds.has(projId)) {
      console.log(`[REUSED] Project for domain '${targetDomain}' already has a completed GitHub source audit. Use --force to re-audit.`);
      return;
    }
    candidates = [{ ...repoMeta, projectId: projId }];
  } else {
    for (const [dom, m] of repoMappings.entries()) {
      const projId = projectIdByDomain.get(dom);
      if (projId) {
        if (!force && alreadyAuditedProjectIds.has(projId)) {
          continue; // Already audited
        }
        candidates.push({ ...m, projectId: projId });
      }
    }
    if (limit) {
      candidates = candidates.slice(0, limit);
    }
  }

  console.log(`Eligible unaudited candidate sites ready for GitHub Direct Audit: ${candidates.length}`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    console.log(`\n[${i + 1}/${candidates.length}] Starting audit for ${c.domain} (${c.repoName})...`);
    try {
      const ok = await auditRepository(c, maxPages, !!args.values.archive, isRemote);
      if (ok) successCount++;
      else failCount++;
    } catch (err: any) {
      console.error(`Audit failed for ${c.domain}:`, err?.message || err);
      failCount++;
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
