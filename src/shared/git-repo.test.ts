import { describe, expect, it } from "vitest";
import {
  isValidRepoSlug,
  normalizeRepoSlug,
  normalizeGitRelativePath,
} from "./git-repo";

describe("src/shared/git-repo", () => {
  describe("isValidRepoSlug (Sol P1-04, Round 20 F08, Round 21 F06)", () => {
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
      expect(isValidRepoSlug("./..")).toBe(false);
      expect(isValidRepoSlug(". /repo")).toBe(false);
      expect(isValidRepoSlug("-owner/repo")).toBe(false);
    });
  });

  describe("normalizeRepoSlug (Sol Round 21 F06)", () => {
    it("returns trimmed slug for valid inputs", () => {
      expect(normalizeRepoSlug("  owner/repo  ")).toBe("owner/repo");
      expect(normalizeRepoSlug("cfpages-site/example")).toBe(
        "cfpages-site/example",
      );
    });

    it("throws for invalid slugs", () => {
      expect(() => normalizeRepoSlug("invalid")).toThrow(
        /Invalid GitHub repository slug/,
      );
      expect(() => normalizeRepoSlug(null)).toThrow(
        /Invalid GitHub repository slug/,
      );
    });
  });

  describe("normalizeGitRelativePath (Sol Round 18 F1, Round 20 F08, Round 21 F06)", () => {
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

    it("rejects drive letters, UNC paths, control characters, and slash-only paths (Sol Round 21 F06)", () => {
      expect(() => normalizeGitRelativePath("C:\\Windows\\System32")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("D:/repo/path")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("\\\\server\\share")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("//server/share")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("/")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("///")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("\\\\\\")).toThrow(
        /clean repository-relative/,
      );
      expect(() => normalizeGitRelativePath("path\x00with\x01control")).toThrow(
        /clean repository-relative/,
      );
    });
  });
});
