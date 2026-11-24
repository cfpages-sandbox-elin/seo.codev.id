/**
 * Shared audit issue skill router for CLI and MCP surfaces.
 * Maps audit issue types and resource URLs to the appropriate remediation skill and action.
 */
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
    pathname.endsWith(".css") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".jpg") ||
    pathname.endsWith(".jpeg") ||
    pathname.endsWith(".gif") ||
    pathname.endsWith(".webp") ||
    pathname.endsWith(".svg") ||
    pathname.includes("/wp-content/");

  // High-value specific routes by descriptor
  if (code === "canonical-conflict" || code.includes("canonical")) {
    return {
      skill: "internal-linking",
      action:
        "Inspect the final page and canonical target, then align the canonical with the intended indexable URL.",
    };
  }

  if (code === "redirect-loop" || code === "redirect-chain") {
    return {
      skill: "seo-audit",
      action:
        "Identify the mutually redirecting URLs and make the intended destination return directly.",
    };
  }

  if (code === "broken-link") {
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

  if (
    code.includes("broken-image") ||
    code.includes("broken-resource") ||
    (isStaticAsset && !code.includes("canonical"))
  ) {
    return {
      skill: "static-site-css-repair",
      action:
        "Repair missing theme assets, unstyled paths, or broken CSS/JS references in static export.",
    };
  }

  if (code.includes("orphan") || code.includes("internal-link")) {
    return {
      skill: "internal-linking",
      action:
        "Establish incoming link mesh from hub pages to money pages and correct internal link hierarchy.",
    };
  }

  if (
    code.includes("title") ||
    code.includes("description") ||
    code.includes("heading") ||
    code.includes("thin-content") ||
    code.includes("duplicate")
  ) {
    return {
      skill: "unslop-seo",
      action:
        "Remove AI fluff, inject 40-word direct answers, and write unique meta title/descriptions.",
    };
  }

  if (
    code.includes("slow") ||
    code.includes("speed") ||
    code.includes("large-page") ||
    code.includes("lighthouse")
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
