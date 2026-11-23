/**
 * Streaming Archive Reader Benchmark CLI (PRD §4.6, FLEET-GH-02)
 *
 * Compares the per-blob download lane against the commit-pinned streamed tarball lane
 * on representative static exports, measuring discovery, transfer, parsing, persistence timings,
 * and peak memory footprint with true cryptographic candidate-set parity verification.
 *
 * Usage:
 *   pnpm exec tsx scripts/benchmark-archive-audit.ts [--domain <domain>] [--repo <owner/repo>]
 */
import { execSync } from "node:child_process";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { parseArgs } from "node:util";
import {
  capBytes,
  streamToBuffer,
  verifyGitBlob,
  parseTarHtmlFiles,
  decompressGzipStream,
} from "./github-archive-utils";

const ENV_FILE = resolve(".env.selfhost");
const MANIFEST_PATH = resolve("src/server/features/fleet/data/fleetManifest.json");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const content = readFileSync(ENV_FILE, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0 && !line.startsWith("#")) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
        env[key] = val;
      }
    }
  } catch {}
  return env;
}

const envVars = loadEnv();
const GITHUB_TOKEN = envVars.GITHUB_TOKEN || process.env.GITHUB_TOKEN;

export async function runBenchmark(repoName: string) {
  const ownerRepoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
  if (!ownerRepoRegex.test(repoName)) {
    throw new Error(`Invalid repository name '${repoName}'. Must match 'owner/repo'.`);
  }

  console.log(`\n=== Streaming Archive Reader Benchmark (FLEET-GH-02) ===`);
  console.log(`Repository: ${repoName}`);

  // 1. Resolve commit SHA and tree
  const repoInfo = JSON.parse(
    execSync(`gh api /repos/${repoName}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
  );
  const defaultBranch = repoInfo.default_branch || "main";
  const commitInfo = JSON.parse(
    execSync(`gh api /repos/${repoName}/commits/${defaultBranch}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
  );
  const commitSha = commitInfo.sha;
  console.log(`Pinned commit: ${commitSha.slice(0, 10)} (${defaultBranch})`);

  const treeJson = execSync(`gh api /repos/${repoName}/git/trees/${commitSha}?recursive=1`, {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parsedTree = JSON.parse(treeJson);
  if (parsedTree.truncated) {
    throw new Error(`Tree was truncated by GitHub API for ${repoName}. Cannot guarantee complete parity.`);
  }

  const htmlBlobs = (parsedTree.tree || []).filter(
    (item: any) =>
      item.type === "blob" &&
      (item.mode === "100644" || item.mode === "100755") &&
      (item.path.endsWith(".html") || item.path.endsWith(".htm")),
  );
  console.log(`Discovered ${htmlBlobs.length} HTML files in repository tree.`);

  // ─── Lane 1: Individual Blob Downloads (Current Baseline) ─────────────────
  console.log(`\nBenchmarking Lane 1: Individual Blob Downloads (concurrency: 25)...`);
  const memStart1 = process.memoryUsage().rss;
  const t0_lane1 = performance.now();

  const lane1Results = new Map<string, Buffer>();
  let lane1TotalBytes = 0;
  const CONCURRENCY = 25;
  for (let i = 0; i < htmlBlobs.length; i += CONCURRENCY) {
    const slice = htmlBlobs.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (file: any) => {
        const rawPath = file.path.split("/").map(encodeURIComponent).join("/");
        const rawUrl = `https://raw.githubusercontent.com/${repoName}/${commitSha}/${rawPath}`;
        try {
          const res = await fetch(rawUrl, {
            headers: {
              ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
              "User-Agent": "OpenSEO-Benchmark-Lane1",
            },
            signal: AbortSignal.timeout(60000),
          });
          if (res.ok) {
            const arrayBuf = await res.arrayBuffer();
            const buf = Buffer.from(arrayBuf);
            verifyGitBlob(buf, file.sha);
            lane1TotalBytes += buf.length;
            lane1Results.set(file.path, buf);
          } else {
            throw new Error(`HTTP ${res.status} fetching ${file.path}`);
          }
        } catch (err: any) {
          throw new Error(`Lane 1 failed to acquire or verify blob ${file.path}: ${err?.message || err}`);
        }
      }),
    );
  }
  const t1_lane1 = performance.now();
  const memEnd1 = process.memoryUsage().rss;
  const lane1DurationMs = Math.round(t1_lane1 - t0_lane1);
  const lane1MemMb = Math.round((memEnd1 - memStart1) / (1024 * 1024));

  console.log(`Lane 1 Complete:`);
  console.log(`  - Files fetched: ${lane1Results.size}/${htmlBlobs.length}`);
  console.log(`  - Wire bytes transferred: ${(lane1TotalBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  - Elapsed time: ${lane1DurationMs} ms (${(lane1DurationMs / 1000).toFixed(2)}s)`);
  console.log(`  - RSS end-minus-start: ${lane1MemMb} MB`);

  // ─── Lane 2: Streamed Commit-Pinned Archive (FLEET-GH-02) ───────────────────
  console.log(`\nBenchmarking Lane 2: Streamed Commit-Pinned Tarball Archive...`);
  const memStart2 = process.memoryUsage().rss;
  const t0_lane2 = performance.now();

  const archiveUrl = `https://codeload.github.com/${repoName}/legacy.tar.gz/${commitSha}`;
  const archiveRes = await fetch(archiveUrl, {
    headers: {
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      "User-Agent": "OpenSEO-Benchmark",
      "Accept-Encoding": "identity",
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!archiveRes.ok) {
    throw new Error(`Failed to download archive: ${archiveRes.status} ${archiveRes.statusText}`);
  }
  const contentLength = archiveRes.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 100 * 1024 * 1024) {
    throw new Error(`Archive exceeds 100MB bound (${contentLength} bytes)`);
  }
  if (!archiveRes.body) {
    throw new Error("Empty archive response body");
  }
  const tDownload_lane2 = performance.now();

  const tarStream = archiveRes.body
    .pipeThrough(capBytes(100 * 1024 * 1024, "compressed archive"))
    .pipeThrough(decompressGzipStream())
    .pipeThrough(capBytes(250 * 1024 * 1024, "expanded archive"));
  const decompressed = await streamToBuffer(tarStream);
  const archiveWireBytes = decompressed.length;
  const tDecompress_lane2 = performance.now();

  const lane2Results = parseTarHtmlFiles(decompressed);
  const t1_lane2 = performance.now();
  const memEnd2 = process.memoryUsage().rss;

  // Cryptographically verify every file in Lane 2 against its expected Git blob ID (Sol P1 - F2)
  for (const file of htmlBlobs) {
    const buf = lane2Results.get(file.path);
    if (!buf) {
      throw new Error(`Lane 2 archive missing candidate file: ${file.path}`);
    }
    verifyGitBlob(buf, file.sha);
  }

  const downloadDurationMs = Math.round(tDownload_lane2 - t0_lane2);
  const decompressDurationMs = Math.round(tDecompress_lane2 - tDownload_lane2);
  const parseDurationMs = Math.round(t1_lane2 - tDecompress_lane2);
  const lane2DurationMs = Math.round(t1_lane2 - t0_lane2);
  const lane2MemMb = Math.round((memEnd2 - memStart2) / (1024 * 1024));

  console.log(`Lane 2 Complete:`);
  console.log(`  - Files extracted: ${lane2Results.size}/${htmlBlobs.length}`);
  console.log(`  - Archive wire bytes transferred: ${(archiveWireBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  - Tarball download time: ${downloadDurationMs} ms`);
  console.log(`  - Gzip decompression time: ${decompressDurationMs} ms`);
  console.log(`  - In-memory tar parse time: ${parseDurationMs} ms`);
  console.log(`  - Total elapsed time: ${lane2DurationMs} ms (${(lane2DurationMs / 1000).toFixed(2)}s)`);
  console.log(`  - RSS end-minus-start: ${lane2MemMb} MB`);

  // ─── Parity & Performance Comparison ───────────────────────────────────────
  console.log(`\n=== Parity & Performance Analysis ===`);

  // Sol P1-02: Cryptographic byte parity assertion over raw binary buffers before text decoding:
  let matchedFiles = 0;
  for (const file of htmlBlobs) {
    const buf1 = lane1Results.get(file.path);
    const buf2 = lane2Results.get(file.path);
    if (buf1 && buf2 && buf1.equals(buf2)) {
      matchedFiles++;
    }
  }

  const parity =
    !parsedTree.truncated &&
    htmlBlobs.length > 0 &&
    lane1Results.size === htmlBlobs.length &&
    lane2Results.size === htmlBlobs.length &&
    matchedFiles === htmlBlobs.length;

  if (!parity) {
    throw new Error(
      `PARITY FAILURE: Candidate set mismatch (Tree: ${htmlBlobs.length}, Lane 1: ${lane1Results.size}, Lane 2: ${lane2Results.size}, Matched: ${matchedFiles})`
    );
  }

  console.log(`\nWorkload Tradeoff Assessment:`);
  console.log(`  - Selective Blob Lane: ${(lane1TotalBytes / (1024 * 1024)).toFixed(2)} MB wire payload, ${lane1DurationMs} ms`);
  console.log(`  - Archive Tarball Lane: ${(archiveWireBytes / (1024 * 1024)).toFixed(2)} MB wire payload, ${lane2DurationMs} ms`);
  return {
    lane1DurationMs,
    lane2DurationMs,
    lane1TotalBytes,
    archiveWireBytes,
    fileCount: htmlBlobs.length,
    parity: true,
  };
}

// CLI execution
if (process.argv[1] && process.argv[1].includes("benchmark-archive-audit")) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      domain: { type: "string" },
    },
  });

  let targetRepo = values.repo;
  if (!targetRepo && values.domain) {
    // Resolve repo from manifest
    try {
      const manifestRaw = readFileSync(MANIFEST_PATH, "utf8");
      const list = JSON.parse(manifestRaw);
      const found = list.find(
        (m: any) => m.canonicalHost?.toLowerCase() === values.domain?.toLowerCase()
      );
      if (found?.repoName) {
        targetRepo = found.repoName;
      }
    } catch {}

    if (!targetRepo) {
      console.error(`[ERROR] Domain '${values.domain}' was not found in fleet manifest.`);
      process.exit(1);
    }
  }

  if (!targetRepo) {
    targetRepo = "cfpages-adistyputriharli/Concrete.co.id";
  }

  runBenchmark(targetRepo).catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
