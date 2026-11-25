import { describe, expect, it } from "vitest";
import { analyzeHtml } from "./page-analyzer";

describe("page-analyzer inert and edge case parsing", () => {
  it("ignores canonical declarations inside inert <template> elements and respects the real document canonical", () => {
    const html = `
      <html>
        <head>
          <template><link rel="canonical" href="/inert"></template>
          <link rel="canonical" href="/real">
        </head>
      </html>
    `;
    const res = analyzeHtml(html, "https://example.com/root/", 200, 0);
    expect(res.canonical).toBe("https://example.com/real");
  });

  it("resolves mixed-case whitespace-delimited rel tokens (e.g. rel='alternate CANONICAL')", () => {
    const html = `
      <html>
        <head>
          <link rel="alternate CANONICAL" href="/real-page">
        </head>
      </html>
    `;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.canonical).toBe("https://example.com/real-page");
  });

  it("rejects non-http canonical schemes and resolves to null", () => {
    const html = `
      <html>
        <head>
          <link rel="canonical" href="javascript:void(0)">
        </head>
      </html>
    `;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.canonical).toBeNull();
  });

  it("handles noscript raw text with unclosed style and resolves effective base and canonical (Sol R2 probe)", () => {
    const html = `<noscript><style></noscript><base href="/real/"><link rel="canonical" href="landing">`;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.baseHref).toBe("/real/");
    expect(res.canonical).toBe("https://example.com/real/landing");
  });

  it("ignores base tags inside SVG elements and respects document-level base (Sol R2 probe)", () => {
    const html = `<html><head><svg><base href="/svg-base/"></svg><base href="/real/"><link rel="canonical" href="landing"></head></html>`;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.baseHref).toBe("/real/");
    expect(res.canonical).toBe("https://example.com/real/landing");
  });

  it("strictly suppresses all template descendants from document evidence (links, meta, h1, images) (Sol R2)", () => {
    const html = `
      <html>
        <head>
          <template>
            <meta name="description" content="inert-desc">
            <a href="/inert-link">Inert Link</a>
            <h1>Inert Heading</h1>
            <img src="/inert.png" alt="Inert Image">
          </template>
          <meta name="description" content="real-desc">
        </head>
        <body>
          <h1>Real Heading</h1>
          <a href="/real-link">Real Link</a>
        </body>
      </html>
    `;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.metaDescription).toBe("real-desc");
    expect(res.h1s).toEqual(["Real Heading"]);
    expect(res.images).toEqual([]);
    expect(res.links.map((l) => l.targetUrl)).toEqual([
      "https://example.com/real-link",
    ]);
  });

  it("handles whitespace in noscript close tag and resolves live base, h1, and anchor (Sol R3 oracle 1)", () => {
    const html = `<noscript><style></noscript ><base href="/real/"><h1>Live</h1><a href="next">Next</a>`;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.baseHref).toBe("/real/");
    expect(res.h1s).toEqual(["Live"]);
    expect(res.links[0]?.targetUrl).toBe("https://example.com/real/next");
  });

  it("handles comment containing noscript without swallowing live content (Sol R3 oracle 2)", () => {
    const html = `<!-- <noscript> --><h1>Live</h1><noscript>Inert</noscript><a href="next">Next</a>`;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.h1s).toEqual(["Live"]);
    expect(res.links[0]?.targetUrl).toBe("https://example.com/dir/next");
  });

  it("preserves visible text and links when tag-like sequences appear in quoted attributes (Sol Round 22 F02)", () => {
    const html = `<p data-example="<noscript>">Catalogue</p><a href="/about">About us</a>`;
    const res = analyzeHtml(html, "https://example.com/dir/", 200, 0);
    expect(res.wordCount).toBeGreaterThanOrEqual(2);
    expect(res.links.map((l) => l.targetUrl)).toContain(
      "https://example.com/about",
    );
  });
});
