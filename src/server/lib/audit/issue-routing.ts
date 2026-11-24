/**
 * Shared audit issue skill router for CLI and MCP surfaces.
 * Maps audit issue types and resource URLs to the appropriate remediation skill and action.
 */
export function routeIssueToSkill(
  issueType: string,
  url: string = "",
): { skill: string; action: string } {
  const t = (issueType || "").toLowerCase().replace(/-/g, "_");
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = (url || "").toLowerCase();
  }

  const isStaticAsset =
    pathname.endsWith(".css") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".gif") ||
    pathname.endsWith(".webp") ||
    pathname.endsWith(".svg") ||
    pathname.includes("/wp-content/");

  if (t.includes("broken_image") || isStaticAsset) {
    return {
      skill: "static-site-css-repair",
      action:
        "Repair missing theme assets, unstyled paths, or broken CSS/JS references in static export.",
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
      action:
        "Establish incoming link mesh from hub pages to money pages and correct canonical references.",
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
      action:
        "Remove AI fluff, inject 40-word direct answers, and write unique meta title/descriptions.",
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
      action:
        "Audit Web Vitals, defer non-critical scripts, and optimize image payloads.",
    };
  }

  return {
    skill: "seo-audit",
    action: "General technical SEO remediation.",
  };
}
