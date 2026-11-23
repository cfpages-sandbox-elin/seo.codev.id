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
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { analyzeHtml } from "../src/server/lib/audit/page-analyzer";
import { runPageReporters, type DetectedIssue } from "../src/server/lib/audit/issues/page-reporters";
import type { CrawledPageResult } from "../src/server/lib/audit/types";
import { deterministicAuditRowId } from "../src/server/lib/audit/ids";
import { getIssueDescriptor } from "../src/shared/audit-issues";

const ENV_FILE = resolve("C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/.env.selfhost");
const FLEET_MANIFEST_FILE = resolve("C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/src/server/features/fleet/data/fleetManifest.json");
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

function executeD1SqlStatements(sqlLines: string[]): void {
  const CHUNK_SIZE = 500;
  for (let i = 0; i < sqlLines.length; i += CHUNK_SIZE) {
    const chunk = sqlLines.slice(i, i + CHUNK_SIZE).join("\n");
    const tempFile = resolve("C:/Users/THINKPAD/Documents/GitHub/seo.codev.id/scratch", `batch_${Date.now()}_${i}.sql`);
    writeFileSync(tempFile, chunk, "utf8");
    try {
      const cmd = `npx wrangler d1 execute open-seo-db-selfhost --remote --file "${tempFile}"`;
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
  return urlOrPath
    .split("#")[0]
    .split("?")[0]
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
};

async function auditRepository(mapping: RepoMapping, maxPages = 10000): Promise<boolean> {
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
      console.warn(`[WARNING] Git tree for ${repoName} is truncated by GitHub (exceeds limit).`);
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
    if (item.type !== "blob") continue;
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

  // Helper to map repo path to public page URL
  const pathToUrl = (path: string): string => {
    let sub = path;
    if (sub === "index.html" || sub === "index.htm") return `https://${domain}/`;
    if (sub.endsWith("/index.html")) {
      return `https://${domain}/${sub.slice(0, -10)}/`;
    }
    if (sub.endsWith("/index.htm")) {
      return `https://${domain}/${sub.slice(0, -9)}/`;
    }
    return `https://${domain}/${sub}`;
  };

  // 3. Fetch and analyze HTML files with paced concurrency
  const auditId = crypto.randomUUID();
  const startTime = Date.now();
  const crawledPages: CrawledPageResult[] = [];
  const detectedIssues: DetectedIssue[] = [];
  const inboundLinkCounts = new Map<string, number>();

  const CONCURRENCY = 25;
  for (let i = 0; i < candidateFiles.length; i += CONCURRENCY) {
    const slice = candidateFiles.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (file) => {
        const pageUrl = pathToUrl(file.path);
        const rawUrl = `https://raw.githubusercontent.com/${repoName}/${commitSha}/${file.path}`;

        try {
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

          const html = await res.text();
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
            crawlDepth: file.path === "index.html" ? 0 : file.path.split("/").length,
            inSitemap: true,
          };

          crawledPages.push(pageResult);

          // Page-level issues
          const issues = runPageReporters(pageResult);
          detectedIssues.push(...issues);

          // Check internal links against known repository routes
          for (const link of analysis.links) {
            if (link.isInternal) {
              const targetNorm = normalizeRoute(link.targetUrl);
              const normPageUrl = normalizeRoute(pageUrl);

              if (targetNorm && targetNorm !== normPageUrl) {
                if (validRouteSet.has(targetNorm)) {
                  inboundLinkCounts.set(targetNorm, (inboundLinkCounts.get(targetNorm) || 0) + 1);
                } else if (
                  link.targetUrl.startsWith(`https://${domain}`) ||
                  link.targetUrl.startsWith(`http://${domain}`) ||
                  link.targetUrl.startsWith("/")
                ) {
                  // Internal dead link confirmed
                  detectedIssues.push({
                    issueType: "broken-internal-link",
                    pageId,
                    pageUrl,
                    dedupeKey: link.targetUrl,
                    details: { targetUrl: link.targetUrl, targetStatus: 404 },
                  });
                }
              }
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

  // 4. Detect Orphan Pages
  const homeNorm = normalizeRoute(domain);
  for (const page of crawledPages) {
    const pageNorm = normalizeRoute(page.url);
    if (pageNorm !== homeNorm && (inboundLinkCounts.get(pageNorm) || 0) === 0) {
      detectedIssues.push({
        issueType: "orphan-page",
        pageId: page.id,
        pageUrl: page.url,
      });
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const attemptedCount = candidateFiles.length;
  const processedCount = crawledPages.length;
  const unreadCount = attemptedCount - processedCount;
  const isComplete = !isTreeTruncated && candidateFiles.length === htmlFiles.length && unreadCount === 0 && processedCount > 0;
  const finalStatus = isComplete ? "completed" : "partial";

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
    // Stage 1: Insert parent audit in 'running' phase
    executeD1SqlStatements([
      `INSERT INTO audits (
        id, project_id, started_by_user_id, start_url,
        workflow_instance_id, config, status, pages_crawled,
        pages_total, lighthouse_total, current_phase, started_at
      ) VALUES (
        '${auditId}', '${projectId}', 'system', 'https://${domain}',
        'github-audit-${auditId}', '${configJson}', 'running', ${processedCount},
        ${htmlFiles.length}, 0, 'analyzing', datetime('now', '-${durationSec} seconds')
      ) ON CONFLICT(id) DO UPDATE SET status = 'running';`,
    ]);

    // Stage 2: Insert audit pages (preserving source provenance, NULL unmeasured runtime evidence)
    const pageSqlLines: string[] = [];
    for (const p of crawledPages) {
      const esc = (s: string | null | undefined) => (s ? `'${s.replace(/'/g, "''")}'` : "NULL");
      pageSqlLines.push(`
        INSERT INTO audit_pages (
          id, audit_id, url, status_code, fetch_class, title, meta_description,
          canonical_url, robots_meta, h1_count, h2_count, h3_count, h4_count, h5_count, h6_count,
          word_count, content_hash, images_total, images_missing_alt, internal_link_count,
          external_link_count, has_structured_data, is_indexable, crawl_depth, in_sitemap, response_time_ms
        ) VALUES (
          '${p.id}', '${auditId}', '${p.url.replace(/'/g, "''")}', NULL, '${p.fetchClass}',
          ${esc(p.title)}, ${esc(p.metaDescription)}, ${esc(p.canonicalUrl)}, ${esc(p.robotsMeta)},
          ${p.h1Count}, ${p.h2Count}, ${p.h3Count}, ${p.h4Count}, ${p.h5Count}, ${p.h6Count},
          ${p.wordCount}, ${esc(p.contentHash)}, ${p.imagesTotal}, ${p.imagesMissingAlt},
          ${p.links.filter((l) => l.isInternal).length}, ${p.links.filter((l) => !l.isInternal).length},
          ${p.hasStructuredData ? 1 : 0}, ${p.isIndexable ? 1 : 0}, NULL, 0, NULL
        ) ON CONFLICT(id) DO NOTHING;
      `);
    }
    if (pageSqlLines.length > 0) {
      executeD1SqlStatements(pageSqlLines);
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
      executeD1SqlStatements(issueSqlLines);
    }

    // Stage 4: Atomic compare-and-set flip to final status
    executeD1SqlStatements([
      `UPDATE audits
       SET status = '${finalStatus}',
           current_phase = 'completed',
           pages_crawled = ${processedCount},
           pages_total = ${htmlFiles.length},
           completed_at = datetime('now')
       WHERE id = '${auditId}' AND status = 'running';`,
    ]);

    console.log(`[SUCCESS] ${domain} audit successfully finalized in D1 as '${finalStatus}'! (${processedCount} pages, ${detectedIssues.length} issues)`);
    return true;
  } catch (d1Err: any) {
    console.error(`[ERROR] D1 persistence failed for ${domain}:`, d1Err?.message || d1Err);
    // Mark audit as failed on error
    try {
      executeD1SqlStatements([
        `UPDATE audits
         SET status = 'failed',
             error_code = 'CHUNK_WRITE_FAILED',
             current_phase = 'failed',
             completed_at = datetime('now')
         WHERE id = '${auditId}';`,
      ]);
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
      "max-pages": { type: "string", short: "m", default: "10000" },
    },
    allowPositionals: true,
  });

  console.log("=== OpenSEO Zero-Limit GitHub Repository Audit Runner ===");
  const targetDomain = args.values.domain?.toLowerCase().trim();
  const limit = args.values.limit ? parseInt(args.values.limit, 10) : undefined;
  const force = !!args.values.force;
  const maxPages = parseInt(args.values["max-pages"] || "10000", 10);

  // Load project mappings from D1
  const projectRows = runD1Query(
    "SELECT id, domain FROM projects WHERE organization_id = 'shared-workspace' AND domain IS NOT NULL AND archived_at IS NULL;"
  );
  const projectIdByDomain = new Map<string, string>();
  for (const p of projectRows) {
    projectIdByDomain.set(p.domain.toLowerCase().trim(), p.id);
  }

  // Load completed audits to avoid redundant work unless --force is given
  const completedAudits = runD1Query("SELECT DISTINCT project_id FROM audits WHERE status = 'completed';");
  const alreadyAuditedProjectIds = new Set(completedAudits.map((a) => a.project_id));

  const repoMappings = loadRepoMappings();
  console.log(`Loaded ${repoMappings.size} repository mappings from manifest & PROJECTS_GITHUB.md.`);

  let candidates: RepoMapping[] = [];
  for (const [dom, m] of repoMappings.entries()) {
    const projId = projectIdByDomain.get(dom);
    if (projId) {
      if (!force && alreadyAuditedProjectIds.has(projId)) {
        continue; // Already audited
      }
      candidates.push({ ...m, projectId: projId });
    }
  }

  if (targetDomain) {
    const exact = candidates.filter((c) => c.domain === targetDomain);
    if (exact.length === 0) {
      console.error(`[ERROR] Domain '${targetDomain}' is not found among enrolled unaudited candidate projects.`);
      process.exit(1);
    }
    candidates = exact;
  }

  if (limit) {
    candidates = candidates.slice(0, limit);
  }

  console.log(`Eligible unaudited candidate sites ready for GitHub Direct Audit: ${candidates.length}`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    console.log(`\n[${i + 1}/${candidates.length}] Starting audit for ${c.domain} (${c.repoName})...`);
    try {
      const ok = await auditRepository(c, maxPages);
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
