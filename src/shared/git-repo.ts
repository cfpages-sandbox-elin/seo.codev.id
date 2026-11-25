/**
 * Shared Git repository and relative path validation utilities.
 * Used across CLI runners, MCP tools, and server workflows (Sol P1-04, Round 20 F08, Round 21 F06).
 */

const OWNER_COMPONENT_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
const REPO_COMPONENT_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

/**
 * Validates repository slug format (Sol P1-04, Round 20 F08, Round 21 F06).
 * Strictly requires owner/repo pattern with standard alphanumeric, dash, dot, or underscore characters.
 * Rejects punctuation-only segments ("." or "..") and whitespace.
 */
export function isValidRepoSlug(slug: string | null | undefined): boolean {
  if (!slug || typeof slug !== "string") return false;
  const trimmed = slug.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  if (!OWNER_COMPONENT_REGEX.test(owner) || !REPO_COMPONENT_REGEX.test(repo)) {
    return false;
  }
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return false;
  }
  return true;
}

/**
 * Returns trimmed and normalized repository slug or throws descriptive validation error (Sol Round 21 F06).
 */
export function normalizeRepoSlug(slug: string | null | undefined): string {
  if (!isValidRepoSlug(slug)) {
    throw new Error(
      `Invalid GitHub repository slug: "${slug}". Must match owner/repo pattern.`,
    );
  }
  return slug!.trim();
}

/**
 * Normalizes roots using one relative Git-path contract (Sol Round 18 F1, Round 20 F08, Round 21 F06).
 * Accepts '.' or a slash-delimited relative path with nonempty components and no '.' or '..' segments.
 * Rejects Windows drive letters (C:), UNC paths (// or \\), control characters, and slash-only paths.
 */
export function normalizeGitRelativePath(p: string | null | undefined): string {
  if (p === null || p === undefined) return ".";
  const raw = String(p).trim();
  if (raw === "" || raw === ".") return ".";

  // Sol Round 21 F06: Reject filesystem prefixes, UNC paths, control chars, and nonempty slash-only inputs
  const hasControl = Array.from(raw).some((c) => {
    const code = c.charCodeAt(0);
    return (code >= 0 && code <= 31) || code === 127;
  });
  if (/^[a-zA-Z]:|^[/\\]{2}/.test(raw) || hasControl || /^[/\\]+$/.test(raw)) {
    throw new Error(
      `Invalid Git relative path '${p}': expected a clean repository-relative publish root without drive letters, UNC paths, or control characters.`,
    );
  }

  const clean = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean === "") return ".";
  const parts = clean.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(
        `Invalid Git relative path '${p}': contains invalid segment '${part}'`,
      );
    }
  }
  return clean;
}
