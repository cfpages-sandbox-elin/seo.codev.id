import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capBytes,
  streamToBuffer,
  verifyGitBlob,
  isValidCanonicalHostname,
  isValidRepoSlug,
  selectEffectiveRosterVersion,
  parseTarHtmlFiles,
  sqlText,
  loadLocalEnv,
  buildSqliteEffectiveRosterSql,
} from "./github-archive-utils";
import {
  buildDiagnosticTripleStatements,
  buildVerifyDiagnosticTripleSql,
  buildFindMatchingCompletedAuditSql,
  computeDiagnosticTripleIds,
} from "./run-github-fleet-audit";
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

    it("rejects invalid hostnames (edge hyphens, illegal characters, numeric/octal IPv4 literals, oversized)", () => {
      expect(isValidCanonicalHostname("")).toBe(false);
      expect(isValidCanonicalHostname("-start.com")).toBe(false);
      expect(isValidCanonicalHostname("end-.com")).toBe(false);
      expect(isValidCanonicalHostname("double..dot.com")).toBe(false);
      expect(isValidCanonicalHostname("has_underscore.com")).toBe(false);
      expect(isValidCanonicalHostname("192.0.2.01")).toBe(false);
      expect(isValidCanonicalHostname("192.0.2.1")).toBe(false);
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

  describe("R32 diagnostic SQL, size budget, pinned clock & env precedence (V1-01..V1-04, V2-01)", () => {
    it("encodes safe ASCII compactly via sqlText and fits 253-char host + 291-char memberId under D1 batch and Windows bounds (V1-02)", () => {
      const host253 = [
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "d".repeat(58) + ".id",
      ].join(".");
      expect(host253.length).toBe(253);
      expect(isValidCanonicalHostname(host253)).toBe(true);
      expect(sqlText(host253)).toBe(`'${host253}'`);
      expect(sqlText("quote'test;1")).toContain("CAST(X'");

      const longMemberId = "m_" + "x".repeat(289);
      expect(longMemberId.length).toBe(291);
      const stmts = buildDiagnosticTripleStatements({
        auditId: "audit_" + "a".repeat(30),
        projectId: "proj_" + "p".repeat(30),
        domain: host253,
        memberId: longMemberId,
        versionId: "roster_" + "v".repeat(30),
        organizationId: "shared-workspace",
        score: 92,
        grade: "A",
        coverage: 100,
        observedAt: "2026-11-27T01:00:00.000Z",
        clockIso: "2026-11-27T01:00:05.000Z",
      });
      expect(stmts).not.toBeNull();
      expect(stmts!.length).toBe(4);
      const joined = stmts!.join("\n");
      const jsonEnvelopeBytes = Buffer.byteLength(
        JSON.stringify([
          "d1",
          "execute",
          "open-seo-db-selfhost",
          "--command",
          joined,
        ]),
        "utf8",
      );
      expect(Buffer.byteLength(joined, "utf8")).toBeLessThan(14_999);
      expect(jsonEnvelopeBytes).toBeLessThan(14_999);
      const conservativeWinChars = 2 * joined.length + 256;
      expect(conservativeWinChars).toBeLessThan(30_000);
    });

    it("pins one UTC clock across diagnostic writes, rejects invalid/future observedAt, and verifies with s.* alias (V1-01, V1-03, V1-04)", () => {
      const clockIso = "2026-11-27T02:00:00.000Z";
      expect(
        buildDiagnosticTripleStatements({
          auditId: "aud_1",
          projectId: "proj_1",
          domain: "kaca.co.id",
          memberId: "mem_1",
          versionId: "ver_1",
          organizationId: "shared-workspace",
          score: 90,
          grade: "A",
          coverage: 100,
          observedAt: "not-a-timestamp",
          clockIso,
        }),
      ).toBeNull();

      expect(
        buildDiagnosticTripleStatements({
          auditId: "aud_1",
          projectId: "proj_1",
          domain: "kaca.co.id",
          memberId: "mem_1",
          versionId: "ver_1",
          organizationId: "shared-workspace",
          score: 90,
          grade: "A",
          coverage: 100,
          observedAt: "2026-11-27T02:00:01.000Z",
          clockIso,
        }),
      ).toBeNull();

      const stmts = buildDiagnosticTripleStatements({
        auditId: "aud_1",
        projectId: "proj_1",
        domain: "kaca.co.id",
        memberId: "mem_1",
        versionId: "ver_1",
        organizationId: "shared-workspace",
        score: 90,
        grade: "A",
        coverage: 100,
        observedAt: "2026-11-27T01:59:59.000Z",
        clockIso,
      })!;
      const pinnedExpr = `julianday('${clockIso}')`;
      expect(stmts[0]).toContain(pinnedExpr);
      expect(stmts[3]).toContain("json_extract('{', '$')");

      const ids = computeDiagnosticTripleIds("aud_1", "ver_1", "mem_1");
      const verifySql = buildVerifyDiagnosticTripleSql(
        ids.runId,
        ids.runItemId,
        ids.snapshotId,
        "aud_1",
        "shared-workspace",
        "ver_1",
        "mem_1",
        "proj_1",
        "kaca.co.id",
        "completed",
        "completed",
        clockIso,
      );
      expect(verifySql).toContain("s.coverage = 100");
      expect(verifySql).toContain("s.score BETWEEN 0 AND 100");
      expect(verifySql).toContain("s.grade =");
      expect(verifySql).not.toContain("fs.coverage");
      expect(verifySql).not.toContain("fs.score");
      expect(verifySql).not.toContain("fs.grade");

      const reuseSql = buildFindMatchingCompletedAuditSql(
        "proj_1",
        "owner/repo",
        ".",
        "abc123",
        "ver_1",
        clockIso,
      );
      expect(reuseSql).toContain("fs.observed_at");
      expect(reuseSql).toContain("a.completed_at");
      expect(
        buildSqliteEffectiveRosterSql("'shared-workspace'", pinnedExpr),
      ).toContain(pinnedExpr);
    });

    it("skips blank .env values in loadLocalEnv so populated lower-priority or ambient vars are preserved (V2-01)", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openseo-env-test-"));
      try {
        fs.writeFileSync(
          path.join(tmp, ".env.selfhost"),
          "EMPTY_KEY=\nSHARED_KEY=from_selfhost\n",
        );
        fs.writeFileSync(
          path.join(tmp, ".env.local"),
          "EMPTY_KEY=from_local\nONLY_LOCAL=yes\n",
        );
        const loaded = loadLocalEnv(tmp);
        expect(loaded.SHARED_KEY).toBe("from_selfhost");
        expect(loaded.EMPTY_KEY).toBe("from_local");
        expect(loaded.ONLY_LOCAL).toBe("yes");

        fs.unlinkSync(path.join(tmp, ".env.local"));
        const reloaded = loadLocalEnv(tmp);
        expect(reloaded.EMPTY_KEY).toBeUndefined();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
