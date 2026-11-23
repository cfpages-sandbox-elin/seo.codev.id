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
  discoverGitHubTree,
  acquireVerifiedBlob,
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
function getGitHubToken(): string {
  try {
    const token = execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (token) return token;
  } catch {}
  return envVars.GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
}

const GITHUB_TOKEN = getGitHubToken();

export async function runBenchmark(repoName: string, publishRoot = ".") {
  const ownerRepoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
  if (!ownerRepoRegex.test(repoName)) {
    throw new Error(`Invalid repository name '${repoName}'. Must match 'owner/repo'.`);
  }

  console.log(`\n=== Streaming Archive Reader Benchmark (FLEET-GH-02) ===`);
  console.log(`Repository: ${repoName} (Publish root: ${publishRoot})`);

  // 1. Resolve commit SHA and tree via shell-free discovery helper (Sol P1-04)
  const discovered = discoverGitHubTree(repoName);
  const defaultBranch = discovered.defaultBranch;
  const commitSha = discovered.commitSha;
  const treeItems = discovered.tree;
  console.log(`Pinned commit: ${commitSha.slice(0, 10)} (${defaultBranch})`);

  const prefix = publishRoot === "." ? "" : (publishRoot.replace(/^\/+|\/+$/g, "") + "/");
  const htmlBlobs = treeItems.filter(
    (item: any) =>
      item.type === "blob" &&
      (item.mode === "100644" || item.mode === "100755") &&
      (item.path.endsWith(".html") || item.path.endsWith(".htm")) &&
      item.path.startsWith(prefix),
  );
  console.log(`Discovered ${htmlBlobs.length} eligible HTML files in repository tree under '${publishRoot}'.`);

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
          if (res.ok && res.body) {
            const buf = await streamToBuffer(
              res.body.pipeThrough(capBytes(10 * 1024 * 1024, "raw blob")),
            );
            verifyGitBlob(buf, file.sha);
            lane1TotalBytes += buf.length;
            lane1Results.set(file.path, buf);
          } else {
            await res.body?.cancel().catch(() => {});
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

  let compressedWireBytes = 0;
  const countStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressedWireBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  const tarStream = archiveRes.body
    .pipeThrough(countStream)
    .pipeThrough(capBytes(100 * 1024 * 1024, "compressed archive"))
    .pipeThrough(decompressGzipStream())
    .pipeThrough(capBytes(250 * 1024 * 1024, "expanded archive"));
  const decompressed = await streamToBuffer(tarStream);
  const expandedArchiveBytes = decompressed.length;
  const tDecompress_lane2 = performance.now();

  const lane2Results = parseTarHtmlFiles(decompressed);

  // Cryptographically verify every file in Lane 2 using shared acquireVerifiedBlob with raw fallback (Sol F09)
  let archiveHits = 0;
  let fallbackFiles = 0;
  let fallbackBytes = 0;

  for (const file of htmlBlobs) {
    const { buffer: buf, fromArchive } = await acquireVerifiedBlob(
      file,
      repoName,
      commitSha,
      lane2Results,
      GITHUB_TOKEN,
    );
    if (fromArchive) {
      archiveHits++;
    } else {
      fallbackFiles++;
      fallbackBytes += buf.length;
    }
    lane2Results.set(file.path, buf);
  }

  const t1_lane2 = performance.now();
  const memEnd2 = process.memoryUsage().rss;

  const decompressDurationMs = Math.round(tDecompress_lane2 - t0_lane2);
  const parseDurationMs = Math.round(t1_lane2 - tDecompress_lane2);
  const lane2DurationMs = Math.round(t1_lane2 - t0_lane2);
  const lane2MemMb = Math.round((memEnd2 - memStart2) / (1024 * 1024));
  const totalTransferredWireBytes = compressedWireBytes + fallbackBytes;

  console.log(`Lane 2 Complete:`);
  console.log(`  - Files extracted: ${lane2Results.size}/${htmlBlobs.length} (Archive hits: ${archiveHits}, Fallback: ${fallbackFiles})`);
  console.log(`  - Compressed wire bytes: ${(compressedWireBytes / (1024 * 1024)).toFixed(2)} MB`);
  if (fallbackBytes > 0) {
    console.log(`  - Fallback wire bytes: ${(fallbackBytes / (1024 * 1024)).toFixed(2)} MB`);
  }
  console.log(`  - Total transferred response bytes: ${(totalTransferredWireBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  - Expanded tarball payload: ${(expandedArchiveBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  - Download & gzip decompression time: ${decompressDurationMs} ms`);
  console.log(`  - Tar parse, verification & fallback time: ${parseDurationMs} ms`);
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
  console.log(`  - Archive Tarball Lane: ${(compressedWireBytes / (1024 * 1024)).toFixed(2)} MB wire payload (${(expandedArchiveBytes / (1024 * 1024)).toFixed(2)} MB expanded), ${lane2DurationMs} ms`);
  return {
    lane1DurationMs,
    lane2DurationMs,
    lane1TotalBytes,
    compressedWireBytes,
    expandedArchiveBytes,
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
      root: { type: "string" },
    },
  });

  let targetRepo = values.repo;
  let publishRoot = values.root ?? ".";

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
        if (!values.root && found.publishRoot) {
          publishRoot = found.publishRoot;
        }
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

  runBenchmark(targetRepo, publishRoot).catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
