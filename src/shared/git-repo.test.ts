import { describe, expect, it } from "vitest";
import { isValidRepoSlug, normalizeGitRelativePath } from "./git-repo";

describe("src/shared/git-repo", () => {
  describe("isValidRepoSlug (Sol P1-04, Round 20 F08)", () => {
    it("accepts valid owner/repo slugs", () => {
      expect(isValidRepoSlug("owner/repo")).toBe(true);
      expect(isValidRepoSlug("owner-name/repo.name")).toBe(true);
      expect(isValidRepoSlug("org_123/sub-repo")).toBe(true);
      expect(isValidRepoSlug("cfpages-site/toiletcubicle-co-id")).toBe(true);
    });

    it("rejects invalid slugs", () => {
      expect(isValidRepoSlug("")).toBe(false);
      expect(isValidRepoSlug(null)).toBe(false);
      expect(isValidRepoSlug(undefined)).toBe(false);
      expect(isValidRepoSlug("bare-repo")).toBe(false);
      expect(isValidRepoSlug("owner/repo/extra")).toBe(false);
      expect(isValidRepoSlug("owner/$(calc.exe)")).toBe(false);
      expect(isValidRepoSlug("owner/repo;rm -rf /")).toBe(false);
      expect(isValidRepoSlug("owner/repo&whoami")).toBe(false);
      expect(isValidRepoSlug("owner /repo")).toBe(false);
    });
  });

  describe("normalizeGitRelativePath (Sol Round 18 F1, Round 20 F08)", () => {
    it("normalizes empty or dot paths to '.'", () => {
      expect(normalizeGitRelativePath("")).toBe(".");
      expect(normalizeGitRelativePath(null)).toBe(".");
      expect(normalizeGitRelativePath(undefined)).toBe(".");
      expect(normalizeGitRelativePath(".")).toBe(".");
      expect(normalizeGitRelativePath("  .  ")).toBe(".");
    });

    it("normalizes nested relative paths", () => {
      expect(normalizeGitRelativePath("src/docs")).toBe("src/docs");
      expect(normalizeGitRelativePath("/src/docs/")).toBe("src/docs");
      expect(normalizeGitRelativePath("src\\docs")).toBe("src/docs");
      expect(normalizeGitRelativePath("dist/public")).toBe("dist/public");
    });

    it("rejects invalid segments containing dot or dot-dot", () => {
      expect(() => normalizeGitRelativePath("../secret")).toThrow();
      expect(() => normalizeGitRelativePath("src/../dist")).toThrow();
      expect(() => normalizeGitRelativePath("src/./dist")).toThrow();
      expect(() => normalizeGitRelativePath("src//dist")).toThrow();
    });
  });
});
