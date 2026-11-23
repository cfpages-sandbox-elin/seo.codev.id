/**
 * Fleet-Wide Aggregated Issue Reporting & CSV Export CLI (PRD §4.4, FLEET-ISSUE-01)
 *
 * Queries technical SEO issues across all completed audits in the organization,
 * parses detailed contexts (target URL, redirect chain, broken asset), maps issues
 * to sovereign skill remediation routes, and exports to RFC 4180 CSV via PapaParse.
 *
 * Usage:
 *   pnpm exec tsx scripts/fleet-issues.ts [--domain <domain>] [--severity <critical|warning|info>] [--type <issue_type>] [--limit <n>] [--csv [file]] [--json]
 */
import { execSync } from "node:child_process";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { parseArgs } from "node:util";
import { isValidCanonicalHostname } from "./github-archive-utils";

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
  const sanitized = query.replace(/\r?\n/g, " ").trim();
  const flag = isRemote ? "--remote" : "--local";
  const dbName = isRemote ? "open-seo-db-selfhost" : "DB";
  const cmd = `npx wrangler d1 execute ${dbName} ${flag} --json --command "${sanitized.replace(/"/g, '\\"')}"`;
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

export function routeIssueToSkill(issueType: string, url: string = ""): {
  skill: string;
  action: string;
} {
  const t = (issueType || "").toLowerCase().replace(/-/g, "_");
  const u = (url || "").toLowerCase();

  if (
    t.includes("broken_image") ||
    u.includes(".css") ||
    u.includes(".js") ||
    u.includes("wp-content")
  ) {
    return {
      skill: "static-site-css-repair",
      action: "Repair missing theme assets, unstyled paths, or broken CSS/JS references in static export.",
    };
  }

  if (
    t.includes("orphan") ||
    t.includes("internal_link") ||
    t.includes("broken_link") ||
    t.includes("redirect_chain") ||
    t.includes("canonical")
  ) {
    return {
      skill: "internal-linking",
      action: "Establish incoming link mesh from hub pages to money pages and correct canonical references.",
    };
  }

  if (
    t.includes("title") ||
    t.includes("description") ||
    t.includes("heading") ||
    t.includes("thin_content") ||
    t.includes("duplicate")
  ) {
    return {
      skill: "unslop-seo",
      action: "Remove AI fluff, inject 40-word direct answers, and write unique meta title/descriptions.",
    };
  }

  if (
    t.includes("slow") ||
    t.includes("speed") ||
    t.includes("large_page") ||
    t.includes("lighthouse")
  ) {
    return {
      skill: "web-perf",
      action: "Audit Web Vitals, defer non-critical scripts, and optimize image payloads.",
    };
  }

  return {
    skill: "seo-audit",
    action: "General technical SEO remediation.",
  };
}

export interface FleetIssueRow {
  projectId: string;
  domain: string;
  auditId: string;
  issueId: string;
  issueType: string;
  severity: string;
  pageUrl: string;
  pageTitle: string | null;
  targetUrl: string | null;
  details: string | null;
  skillRoute: string;
  recommendedAction: string;
}

export async function getAggregatedFleetIssues(options: {
  remote?: boolean;
  domain?: string;
  severity?: string;
  issueType?: string;
  limit?: number;
}): Promise<FleetIssueRow[]> {
  const isRemote = options.remote ?? true;
  const rawLimit = options.limit ?? 200;
  const limit = Math.max(1, Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 200));

  const whereClauses: string[] = [
    "p.organization_id = 'shared-workspace'",
    "p.archived_at IS NULL",
    "a.status = 'completed'",
  ];

  if (options.domain) {
    whereClauses.push(`p.domain = '${options.domain.toLowerCase().trim().replace(/'/g, "''")}'`);
  }
  if (options.severity) {
    whereClauses.push(`i.severity = '${options.severity.toLowerCase().trim().replace(/'/g, "''")}'`);
  }
  if (options.issueType) {
    whereClauses.push(`i.issue_type = '${options.issueType.trim().replace(/'/g, "''")}'`);
  }

  // Sol P1-7: Select authoritative i.page_url directly rather than pg.url from LEFT JOIN,
  // preventing null dereference for site-level issues where page_id is NULL.
  const query = `
    SELECT 
      p.id AS project_id,
      p.domain AS domain,
      a.id AS audit_id,
      i.id AS issue_id,
      i.issue_type AS issue_type,
      i.severity AS severity,
      COALESCE(i.page_url, pg.url, '') AS page_url,
      pg.title AS page_title,
      i.details_json AS details_json
    FROM audit_issues i
    JOIN audits a ON a.id = i.audit_id
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN audit_pages pg ON pg.id = i.page_id AND pg.audit_id = i.audit_id
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY 
      CASE i.severity 
        WHEN 'critical' THEN 1 
        WHEN 'warning' THEN 2 
        ELSE 3 
      END,
      p.domain ASC,
      i.id DESC
    LIMIT ${limit};
  `;

  const rows = runD1Query(query, isRemote);
  return rows.map((r) => {
    let parsedTargetUrl: string | null = null;
    let detailsStr: string | null = null;
    if (r.details_json) {
      try {
        const parsed = JSON.parse(r.details_json);
        if (parsed && typeof parsed === "object" && typeof parsed.targetUrl === "string") {
          parsedTargetUrl = parsed.targetUrl;
        }
        detailsStr = typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
      } catch {
        detailsStr = r.details_json;
      }
    }

    const effectivePageUrl = r.page_url || "";
    const routing = routeIssueToSkill(r.issue_type, parsedTargetUrl || effectivePageUrl);
    return {
      projectId: r.project_id,
      domain: r.domain,
      auditId: r.audit_id,
      issueId: r.issue_id,
      issueType: r.issue_type,
      severity: r.severity,
      pageUrl: effectivePageUrl,
      pageTitle: r.page_title || null,
      targetUrl: parsedTargetUrl,
      details: detailsStr,
      skillRoute: routing.skill,
      recommendedAction: routing.action,
    };
  });
}

// CLI execution
if (process.argv[1] && process.argv[1].includes("fleet-issues")) {
  // Extract custom --csv argument cleanly preserving subsequent options (Sol P2-02)
  const words = process.argv.slice(2);
  const csvIndex = words.indexOf("--csv");
  let csvTargetFile: string | null = null;
  if (csvIndex >= 0) {
    const nextWord = words[csvIndex + 1];
    const hasFilename = Boolean(nextWord && !nextWord.startsWith("-"));
    csvTargetFile = hasFilename ? nextWord : "fleet-issues.csv";
    words.splice(csvIndex, hasFilename ? 2 : 1);
  }

  const { values } = parseArgs({
    args: words,
    options: {
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
      domain: { type: "string" },
      severity: { type: "string" },
      type: { type: "string" },
      limit: { type: "string", default: "200" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });

  const isRemote = !values.local;

  if (values.domain !== undefined) {
    const trimmedDomain = String(values.domain).toLowerCase().trim();
    if (!isValidCanonicalHostname(trimmedDomain)) {
      console.error(`[ERROR] Invalid domain format: '${values.domain}'. Must be a canonical hostname.`);
      process.exit(1);
    }
  }

  if (values.severity && typeof values.severity === "string") {
    const validSeverities = new Set(["critical", "warning", "info"]);
    if (!validSeverities.has(values.severity.toLowerCase().trim())) {
      console.error(`[ERROR] Invalid severity: '${values.severity}'. Must be one of: critical, warning, info.`);
      process.exit(1);
    }
  }

  let limit = 200;
  if (values.limit) {
    if (!/^[1-9][0-9]*$/.test(String(values.limit))) {
      console.error("[ERROR] Invalid --limit value. Must be a positive integer.");
      process.exit(1);
    }
    limit = Math.min(1000, parseInt(String(values.limit), 10));
  }

  getAggregatedFleetIssues({
    remote: isRemote,
    domain: values.domain as string | undefined,
    severity: values.severity as string | undefined,
    issueType: values.type as string | undefined,
    limit,
  })
    .then((issues) => {
      // 1. Export CSV if requested
      if (csvTargetFile) {
        const fields = [
          "domain",
          "severity",
          "issueType",
          "pageUrl",
          "targetUrl",
          "skillRoute",
          "recommendedAction",
          "details",
          "auditId",
          "issueId",
          "projectId",
        ];
        const csvContent = Papa.unparse(
          {
            fields,
            data: issues.map((i) => ({
              domain: i.domain,
              severity: i.severity,
              issueType: i.issueType,
              pageUrl: i.pageUrl,
              targetUrl: i.targetUrl || "",
              skillRoute: i.skillRoute,
              recommendedAction: i.recommendedAction,
              details: i.details || "",
              auditId: i.auditId,
              issueId: i.issueId,
              projectId: i.projectId,
            })),
          },
          { escapeFormulae: true }
        );
        writeFileSync(csvTargetFile, csvContent, "utf8");
        console.log(`[CSV] Exported ${issues.length} fleet issues to ${csvTargetFile} (RFC 4180 with formula escaping)`);
        return;
      }

      // 2. Output JSON if requested
      if (values.json) {
        console.log(JSON.stringify(issues, null, 2));
        return;
      }

      // 3. Human console overview
      console.log(`\n=== OpenSEO Fleet-Wide Aggregated Issues (FLEET-ISSUE-01) ===`);
      console.log(`Total sample issues retrieved: ${issues.length} (limit: ${limit})`);

      if (issues.length === 0) {
        console.log("No issues found matching the specified criteria.");
        return;
      }

      // Rollup by severity
      const bySeverity = { critical: 0, warning: 0, info: 0 };
      const byType: Record<string, number> = {};
      const bySkill: Record<string, number> = {};

      for (const i of issues) {
        if (i.severity in bySeverity) bySeverity[i.severity as keyof typeof bySeverity]++;
        byType[i.issueType] = (byType[i.issueType] || 0) + 1;
        bySkill[i.skillRoute] = (bySkill[i.skillRoute] || 0) + 1;
      }

      console.log(`\nSeverity Breakdown:`);
      console.log(`  - Critical: ${bySeverity.critical}`);
      console.log(`  - Warning:  ${bySeverity.warning}`);
      console.log(`  - Info:     ${bySeverity.info}`);

      console.log(`\nTop Issue Types:`);
      Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .forEach(([t, count]) => console.log(`  - ${t}: ${count}`));

      console.log(`\nSovereign Skill Remediation Routing:`);
      Object.entries(bySkill)
        .sort((a, b) => b[1] - a[1])
        .forEach(([s, count]) => console.log(`  - /${s}: ${count} issues`));

      console.log(`\nSample Issues (first 5):`);
      issues.slice(0, 5).forEach((i) => {
        console.log(`  [${i.severity.toUpperCase()}] ${i.domain} - ${i.issueType} on ${i.pageUrl}`);
        if (i.targetUrl) console.log(`     Target: ${i.targetUrl}`);
        console.log(`     Routing: /${i.skillRoute} -> ${i.recommendedAction}`);
      });
    })
    .catch((err) => {
      console.error("Failed to query fleet issues:", err);
      process.exit(1);
    });
}
