/**
 * Shared Git repository and relative path validation utilities.
 * Used across CLI runners, MCP tools, and server workflows (Sol P1-04, Round 20 F08).
 */

/**
 * Validates repository slug format (Sol P1-04, Round 20 F08).
 * Strictly requires owner/repo pattern with standard alphanumeric, dash, dot, or underscore characters.
 */
export function isValidRepoSlug(slug: string | null | undefined): boolean {
  if (!slug || typeof slug !== "string") return false;
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(slug.trim());
}

/**
 * Normalizes roots using one relative Git-path contract (Sol Round 18 F1, Round 20 F08).
 * Accepts '.' or a slash-delimited relative path with nonempty components and no '.' or '..' segments.
 */
export function normalizeGitRelativePath(p: string | null | undefined): string {
  if (!p) return ".";
  const trimmed = p.trim().replace(/\\/g, "/");
  if (trimmed === "" || trimmed === ".") return ".";
  const clean = trimmed.replace(/^\/+|\/+$/g, "");
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
