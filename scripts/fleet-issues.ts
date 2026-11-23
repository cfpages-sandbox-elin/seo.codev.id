/**
 * Fleet-Wide Aggregated Issue Reporting & CSV Export CLI (PRD §4.4, FLEET-ISSUE-01)
 *
 * Aggregates technical SEO defects across all enrolled projects, groups identical
 * symptoms by root cause, and generates structured remediation packets with direct
 * sovereign skill routing tags (static-site-css-repair, internal-linking, unslop-seo).
 *
 * Usage:
 *   pnpm exec tsx scripts/fleet-issues.ts [--remote] [--csv <path>] [--domain <domain>] [--severity <error|warning|info>] [--limit <n>]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Papa from "papaparse";

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
    // optional
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

export function routeIssueToSkill(issueType: string, url: string = ""): {
  skill: string;
  action: string;
} {
  const t = issueType.toLowerCase().replace(/-/g, "_");
  const u = url.toLowerCase();

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
  severity: "critical" | "warning" | "info";
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
  const limit = options.limit ?? 200;

  const whereClauses: string[] = [
    "p.organization_id = 'shared-workspace'",
    "p.archived_at IS NULL",
    "a.status = 'completed'",
  ];

  if (options.domain) {
    whereClauses.push(`p.domain = '${options.domain.replace(/'/g, "''")}'`);
  }
  if (options.severity) {
    whereClauses.push(`i.severity = '${options.severity.replace(/'/g, "''")}'`);
  }
  if (options.issueType) {
    whereClauses.push(`i.issue_type = '${options.issueType.replace(/'/g, "''")}'`);
  }

  const query = `
    SELECT 
      p.id AS project_id,
      p.domain AS domain,
      a.id AS audit_id,
      i.id AS issue_id,
      i.issue_type AS issue_type,
      i.severity AS severity,
      pg.url AS page_url,
      pg.title AS page_title,
      i.details_json AS details_json
    FROM audit_issues i
    JOIN audits a ON a.id = i.audit_id
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN audit_pages pg ON pg.id = i.page_id
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
        if (parsed && typeof parsed.targetUrl === "string") {
          parsedTargetUrl = parsed.targetUrl;
        }
        detailsStr = typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
      } catch {
        detailsStr = r.details_json;
      }
    }

    const routing = routeIssueToSkill(r.issue_type, parsedTargetUrl || r.page_url);
    return {
      projectId: r.project_id,
      domain: r.domain,
      auditId: r.audit_id,
      issueId: r.issue_id,
      issueType: r.issue_type,
      severity: r.severity,
      pageUrl: r.page_url || "",
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
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      remote: { type: "boolean", default: true },
      local: { type: "boolean", default: false },
      csv: { type: "string" },
      domain: { type: "string" },
      severity: { type: "string" },
      type: { type: "string" },
      limit: { type: "string", default: "200" },
      json: { type: "boolean", default: false },
    },
  });

  const isRemote = !values.local;
  const limit = parseInt(values.limit || "200", 10);

  getAggregatedFleetIssues({
    remote: isRemote,
    domain: values.domain,
    severity: values.severity,
    issueType: values.type,
    limit,
  })
    .then((issues) => {
      console.log(`\n=== OpenSEO Fleet-Wide Aggregated Issues (FLEET-ISSUE-01) ===`);
      console.log(`Total issues retrieved: ${issues.length}`);

      if (issues.length === 0) {
        console.log("No issues found matching the specified criteria.");
        return;
      }

      // Rollup by severity
      const bySeverity = { critical: 0, warning: 0, info: 0 };
      const byType: Record<string, number> = {};
      const bySkill: Record<string, number> = {};

      for (const i of issues) {
        if (i.severity in bySeverity) bySeverity[i.severity]++;
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

      if (values.csv) {
        const csvPath = resolve(values.csv);
        const csvData = Papa.unparse(issues);
        writeFileSync(csvPath, csvData, "utf8");
        console.log(`\nExported complete issue list to CSV: ${csvPath}`);
      }

      if (values.json) {
        console.log("\nJSON Remediation Packet Preview:");
        console.log(JSON.stringify(issues.slice(0, 5), null, 2));
      }
    })
    .catch((err) => {
      console.error("Fleet issue aggregation failed:", err);
      process.exit(1);
    });
}
