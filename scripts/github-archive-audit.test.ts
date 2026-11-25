import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  capBytes,
  streamToBuffer,
  verifyGitBlob,
  isValidCanonicalHostname,
  isValidRepoSlug,
  selectEffectiveRosterVersion,
  parseTarHtmlFiles,
} from "./github-archive-utils";
import { analyzeHtml } from "../src/server/lib/audit/page-analyzer";
import zlib from "node:zlib";

describe("GitHub Archive & Git Ingestion Utils", () => {
  describe("capBytes", () => {
    it("allows streams within limit", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      const capped = stream.pipeThrough(capBytes(10, "test"));
      const result = await streamToBuffer(capped);
      expect(result).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    });

    it("aborts stream early when chunk exceeds byte limit (Sol F1)", async () => {
      let cancelled = false;
      const chunk1 = new Uint8Array(60);
      const chunk2 = new Uint8Array(60); // Total 120 > 100
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });

      const capped = stream.pipeThrough(capBytes(100, "compressed archive"));
      await expect(streamToBuffer(capped)).rejects.toThrow(
        /compressed archive exceeds byte limit/,
      );
    });
  });

  describe("verifyGitBlob", () => {
    it("passes when bytes match Git SHA-1 blob identity", () => {
      const fixture = Buffer.from("<html>fixture</html>");
      const expectedSha = crypto
        .createHash("sha1")
        .update("blob " + fixture.length + "\0")
        .update(fixture)
        .digest("hex");

      expect(() => verifyGitBlob(fixture, expectedSha)).not.toThrow();
    });

    it("rejects when body bytes do not match expected Git blob SHA (Sol F2)", () => {
      const wrongBytes = Buffer.from("<html>wrong</html>");
      const pinnedBytes = Buffer.from("<html>pinned</html>");
      const pinnedSha = crypto
        .createHash("sha1")
        .update("blob " + pinnedBytes.length + "\0")
        .update(pinnedBytes)
        .digest("hex");

      expect(() => verifyGitBlob(wrongBytes, pinnedSha)).toThrow(
        /Git blob identity mismatch/,
      );
    });

    it("rejects malformed SHA format", () => {
      expect(() =>
        verifyGitBlob(Buffer.from("test"), "not-a-valid-sha"),
      ).toThrow(/Invalid Git blob ID/);
    });
  });

  describe("isValidCanonicalHostname", () => {
    it("accepts valid RFC 1123 hostnames including single-letter labels (Sol F6)", () => {
      expect(isValidCanonicalHostname("a.id")).toBe(true);
      expect(isValidCanonicalHostname("kaca.co.id")).toBe(true);
      expect(isValidCanonicalHostname("toiletcubicle.co.id")).toBe(true);
      expect(isValidCanonicalHostname("sub.domain.example.com")).toBe(true);
    });

    it("rejects invalid hostnames (edge hyphens, illegal characters, oversized)", () => {
      expect(isValidCanonicalHostname("")).toBe(false);
      expect(isValidCanonicalHostname("-start.com")).toBe(false);
      expect(isValidCanonicalHostname("end-.com")).toBe(false);
      expect(isValidCanonicalHostname("double..dot.com")).toBe(false);
      expect(isValidCanonicalHostname("has_underscore.com")).toBe(false);
      expect(isValidCanonicalHostname("a".repeat(255) + ".com")).toBe(false);
    });
  });

  describe("parseTarHtmlFiles", () => {
    it("extracts regular HTML files while ignoring non-HTML and non-regular files", () => {
      const fileContent = Buffer.from("<h1>Hello OpenSEO</h1>");
      const header = Buffer.alloc(512);
      header.write("repo-main/index.html");
      header.write(fileContent.length.toString(8), 124);
      header[156] = 48; // Regular file ('0')

      const paddedSize = Math.ceil(fileContent.length / 512) * 512;
      const contentBlock = Buffer.alloc(paddedSize);
      fileContent.copy(contentBlock);

      const tarball = Buffer.concat([header, contentBlock, Buffer.alloc(1024)]); // null blocks at end
      const result = parseTarHtmlFiles(tarball);

      expect(result.size).toBe(1);
      expect(result.has("index.html")).toBe(true);
      expect(result.get("index.html")?.toString("utf8")).toBe(
        "<h1>Hello OpenSEO</h1>",
      );
    });
  });

  describe("isValidRepoSlug (Sol P1-04)", () => {
    it("accepts valid owner/repo slugs", () => {
      expect(isValidRepoSlug("owner/repo")).toBe(true);
      expect(isValidRepoSlug("owner-name/repo.name")).toBe(true);
      expect(isValidRepoSlug("org_123/sub-repo")).toBe(true);
      expect(isValidRepoSlug("cfpages-site/toiletcubicle-co-id")).toBe(true);
    });

    it("rejects malicious or malformed repository slugs", () => {
      expect(isValidRepoSlug("")).toBe(false);
      expect(isValidRepoSlug("bare-repo")).toBe(false);
      expect(isValidRepoSlug("owner/repo/extra")).toBe(false);
      expect(isValidRepoSlug("owner/$(calc.exe)")).toBe(false);
      expect(isValidRepoSlug("owner/repo;rm -rf /")).toBe(false);
      expect(isValidRepoSlug("owner/repo&whoami")).toBe(false);
      expect(isValidRepoSlug("owner /repo")).toBe(false);
    });
  });

  describe("selectEffectiveRosterVersion (Sol P1-03)", () => {
    const nowMs = Date.parse("2026-11-24T00:00:00.000Z");

    it("selects newest effective roster before cutoff and filters future approvals", () => {
      const versions = [
        { id: "v_future", approved_at: "2026-12-01 00:00:00" },
        { id: "v_older", approved_at: "2026-11-20 12:00:00" },
        { id: "v_effective", approved_at: "2026-11-23 09:00:00" },
      ];
      const selected = selectEffectiveRosterVersion(versions, nowMs);
      expect(selected?.id).toBe("v_effective");
    });

    it("normalizes mixed timestamp formats (ISO vs space) and breaks ties by ID", () => {
      const versions = [
        { id: "v_a", approved_at: "2026-11-22T10:00:00.000Z" },
        { id: "v_b", approved_at: "2026-11-22 10:00:00" },
      ];
      // Same timestamp -> tie-breaker by id descending ("v_b" > "v_a")
      const selected = selectEffectiveRosterVersion(versions, nowMs);
      expect(selected?.id).toBe("v_b");
    });

    it("returns null if no versions are at or before nowMs", () => {
      const versions = [{ id: "v_future", approved_at: "2026-11-25 00:00:00" }];
      expect(selectEffectiveRosterVersion(versions, nowMs)).toBeNull();
    });

    it("breaks identical timestamps by UTF-8 BINARY/C order across ASCII and supplementary Unicode (Sol R2)", () => {
      const asciiTie = [
        { id: "Z", approved_at: "2026-11-22T10:00:00.000Z" },
        { id: "a", approved_at: "2026-11-22T10:00:00.000Z" },
      ];
      expect(selectEffectiveRosterVersion(asciiTie, nowMs)?.id).toBe("a");

      // U+10000 (UTF-8 F0 90 80 80) > U+E000 (UTF-8 EE 80 80) in UTF-8 byte order despite U+10000 < U+E000 in UTF-16 code units
      const utf8Tie = [
        { id: "\uE000", approved_at: "2026-11-22T10:00:00.000Z" },
        { id: "\u{10000}", approved_at: "2026-11-22T10:00:00.000Z" },
      ];
      expect(selectEffectiveRosterVersion(utf8Tie, nowMs)?.id).toBe(
        "\u{10000}",
      );
    });
  });

  describe("analyzeHtml link truncation detection (Sol P2-03)", () => {
    it("reports truncatedLinks=false on ordinary pages with <1,000 links", () => {
      const html =
        "<html><body><a href='/about'>About</a><a href='/contact'>Contact</a></body></html>";
      const result = analyzeHtml(html, "https://example.com/", 200, 50);
      expect(result.truncatedLinks).toBe(false);
      expect(result.links.length).toBe(2);
    });

    it("does NOT trip truncatedLinks on duplicate anchors after 1,000 distinct links (Sol P2-02)", () => {
      // 1,000 unique links + 10 duplicate links of the first target
      const uniqueLinks = Array.from(
        { length: 1000 },
        (_, i) => `<a href="/page-${i}">Link ${i}</a>`,
      ).join("\n");
      const duplicates = Array.from(
        { length: 10 },
        () => `<a href="/page-0">Duplicate</a>`,
      ).join("\n");
      const html = `<html><body>${uniqueLinks}\n${duplicates}</body></html>`;
      const result = analyzeHtml(html, "https://example.com/", 200, 50);
      expect(result.truncatedLinks).toBe(false);
      expect(result.links.length).toBe(1000);
    });

    it("reports truncatedLinks=true when unique links exceed MAX_EXTRACTED_LINKS (1,000)", () => {
      const links = Array.from(
        { length: 1005 },
        (_, i) => `<a href="/page-${i}">Link ${i}</a>`,
      ).join("\n");
      const html = `<html><body>${links}</body></html>`;
      const result = analyzeHtml(html, "https://example.com/", 200, 50);
      expect(result.truncatedLinks).toBe(true);
      expect(result.links.length).toBe(1000);
    });
  });
});
