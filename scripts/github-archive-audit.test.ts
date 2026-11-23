import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  capBytes,
  streamToBuffer,
  verifyGitBlob,
  isValidCanonicalHostname,
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
      await expect(streamToBuffer(capped)).rejects.toThrow(/compressed archive exceeds byte limit/);
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

      expect(() => verifyGitBlob(wrongBytes, pinnedSha)).toThrow(/Git blob identity mismatch/);
    });

    it("rejects malformed SHA format", () => {
      expect(() => verifyGitBlob(Buffer.from("test"), "not-a-valid-sha")).toThrow(/Invalid Git blob ID/);
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
      expect(result.get("index.html")?.toString("utf8")).toBe("<h1>Hello OpenSEO</h1>");
    });
  });

  describe("analyzeHtml link truncation detection (Sol P2-03)", () => {
    it("reports truncatedLinks=false on ordinary pages with <1,000 links", () => {
      const html = "<html><body><a href='/about'>About</a><a href='/contact'>Contact</a></body></html>";
      const result = analyzeHtml(html, "https://example.com/", 200, 50);
      expect(result.truncatedLinks).toBe(false);
      expect(result.links.length).toBe(2);
    });

    it("reports truncatedLinks=true when unique links exceed MAX_EXTRACTED_LINKS (1,000)", () => {
      const links = Array.from({ length: 1005 }, (_, i) => `<a href="/page-${i}">Link ${i}</a>`).join("\n");
      const html = `<html><body>${links}</body></html>`;
      const result = analyzeHtml(html, "https://example.com/", 200, 50);
      expect(result.truncatedLinks).toBe(true);
      expect(result.links.length).toBe(1000);
    });
  });
});
