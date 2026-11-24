/**
 * Shared audit issue skill router for CLI and MCP surfaces.
 * Maps audit issue types and resource URLs to the appropriate remediation skill and action.
 */

const STATIC_EXTENSIONS = [
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
] as const;

const WP_CONTENT_MARKERS = [
  "/wp-content/themes/",
  "/wp-content/plugins/",
  "/wp-content/uploads/",
] as const;

const BROKEN_LINK_PATTERNS = [
  "broken-link",
  "broken-internal-link",
  "broken-external-link",
] as const;

const BROKEN_ASSET_PATTERNS = [
  "broken-image",
  "broken-resource",
  "broken-asset",
  "404-resource",
] as const;

const ON_PAGE_PATTERNS = [
  "title",
  "description",
  "heading",
  "thin-content",
  "duplicate",
  "alt",
] as const;

const PERF_PATTERNS = [
  "slow",
  "speed",
  "large-page",
  "lighthouse",
] as const;

function hasAny(target: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (target.includes(pattern)) return true;
  }
  return false;
}

function hasAnySuffix(target: string, suffixes: readonly string[]): boolean {
  for (const suffix of suffixes) {
    if (target.endsWith(suffix)) return true;
  }
  return false;
}

export function routeIssueToSkill(
  issueType: string,
  url: string = "",
): { skill: string; action: string } {
  const code = (issueType || "").toLowerCase().replace(/_/g, "-");
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = (url || "").toLowerCase();
  }

  const isStaticAsset =
    hasAnySuffix(pathname, STATIC_EXTENSIONS) ||
    hasAny(pathname, WP_CONTENT_MARKERS);

  // 1. Canonical conflicts always route to internal-linking
  if (code.includes("canonical")) {
    return {
      skill: "internal-linking",
      action:
        "Inspect the final page and canonical target, then align the canonical with the intended indexable URL.",
    };
  }

  // 2. Redirect loops vs redirect chains (Sol T2)
  if (code.includes("redirect-loop")) {
    return {
      skill: "seo-audit",
      action:
        "Identify circular redirect loops and break the cycle so the URL resolves cleanly.",
    };
  }

  if (code.includes("redirect-chain")) {
    return {
      skill: "seo-audit",
      action:
        "Shorten multi-hop redirect chains so the source URL redirects directly to the final intended destination.",
    };
  }

  // 3. Broken external links (Sol T4)
  if (code.includes("broken-external-link")) {
    return {
      skill: "seo-audit",
      action:
        "Update or replace broken external links or verify third-party target URL status.",
    };
  }

  // 4. Broken link classes (broken-link, broken-internal-link)
  if (hasAny(code, BROKEN_LINK_PATTERNS)) {
    if (isStaticAsset) {
      return {
        skill: "static-site-css-repair",
        action:
          "Repair missing theme assets, unstyled paths, or broken CSS/JS references in static export.",
      };
    }
    return {
      skill: "internal-linking",
      action:
        "Update or replace broken internal links with valid, live indexable target URLs.",
    };
  }

  // 4. Broken asset classes (broken-image, broken-resource, 404 on assets)
  if (hasAny(code, BROKEN_ASSET_PATTERNS)) {
    return {
      skill: "static-site-css-repair",
      action:
        "Repair missing theme assets, unstyled paths, or broken CSS/JS references in static export.",
    };
  }

  // 5. Server errors (HTTP 5xx)
  if (code.includes("server-error") || code.includes("5xx")) {
    return {
      skill: "seo-audit",
      action:
        "Investigate HTTP 5xx server error, isolate endpoint failure, and restore reliable response.",
    };
  }

  // 6. Orphans and internal linking
  if (code.includes("orphan") || code.includes("internal-link")) {
    return {
      skill: "internal-linking",
      action:
        "Establish incoming link mesh from hub pages to money pages and correct internal link hierarchy.",
    };
  }

  // 7. On-page content issues (titles, descriptions, headings, alt text)
  if (hasAny(code, ON_PAGE_PATTERNS)) {
    return {
      skill: "unslop-seo",
      action:
        "Remove AI fluff, inject 40-word direct answers, and write unique meta title/descriptions.",
    };
  }

  // 8. Performance issues
  if (hasAny(code, PERF_PATTERNS)) {
    return {
      skill: "web-perf",
      action:
        "Audit Web Vitals, defer non-critical scripts, and optimize image payloads.",
    };
  }

  return {
    skill: "seo-audit",
    action: "General technical SEO remediation.",
  };
}
