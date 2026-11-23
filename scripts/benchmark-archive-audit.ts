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

/**
 * In-memory zero-disk tarball parser for gzipped ustar archives.
 * Bounds entry size to 5MB and extracts regular HTML files under the repository root.
 */
export function parseTarHtmlFiles(
  tarBuf: Buffer,
  maxEntrySize = 5 * 1024 * 1024,
): Map<string, Buffer> {
  const htmlMap = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);

    let isAllZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isAllZero = false;
        break;
      }
    }
    if (isAllZero) break;

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;

    const slashIdx = fullName.indexOf("/");
    const relPath = slashIdx !== -1 ? fullName.slice(slashIdx + 1) : fullName;

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8);

    const typeFlag = header[156];
    const isRegularFile = typeFlag === 0 || typeFlag === 48; // ASCII '0' = 48

    const contentStart = offset + 512;
    const contentEnd = contentStart + (isNaN(size) ? 0 : size);

    if (
      isRegularFile &&
      !isNaN(size) &&
      size <= maxEntrySize &&
      (relPath.endsWith(".html") || relPath.endsWith(".htm"))
    ) {
      if (contentEnd <= tarBuf.length) {
        const contentBuf = Buffer.from(tarBuf.subarray(contentStart, contentEnd));
        htmlMap.set(relPath, contentBuf);
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset += 512 + (isNaN(paddedSize) ? 512 : paddedSize);
  }

  return htmlMap;
}

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
        const rawUrl = `https://raw.githubusercontent.com/${repoName}/${commitSha}/${file.path}`;
        try {
          const res = await fetch(rawUrl, {
            headers: {
              ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
              "User-Agent": "OpenSEO-Benchmark-Lane1",
            },
          });
          if (res.ok) {
            const arrayBuf = await res.arrayBuffer();
            const buf = Buffer.from(arrayBuf);
            lane1TotalBytes += buf.length;
            lane1Results.set(file.path, buf);
          }
        } catch {}
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
      ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
      "User-Agent": "OpenSEO-Benchmark",
    },
  });
  if (!archiveRes.ok) {
    throw new Error(`Failed to download archive: ${archiveRes.status} ${archiveRes.statusText}`);
  }
  const archiveArrayBuf = await archiveRes.arrayBuffer();
  const tDownload_lane2 = performance.now();

  const tarballBuffer = Buffer.from(archiveArrayBuf);
  const archiveWireBytes = tarballBuffer.length;
  if (archiveWireBytes > 100 * 1024 * 1024) {
    throw new Error(`Archive wire payload exceeds safe 100MB bound (${archiveWireBytes} bytes)`);
  }
  const decompressed = zlib.gunzipSync(tarballBuffer, { maxOutputLength: 250 * 1024 * 1024 });
  const tDecompress_lane2 = performance.now();

  const lane2Results = parseTarHtmlFiles(decompressed);
  const t1_lane2 = performance.now();
  const memEnd2 = process.memoryUsage().rss;

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
  let mismatchedContent = 0;
  for (const file of htmlBlobs) {
    const buf1 = lane1Results.get(file.path);
    const buf2 = lane2Results.get(file.path);
    if (buf1 !== undefined && buf2 !== undefined) {
      const d1 = crypto.createHash("sha256").update(buf1).digest("hex");
      const d2 = crypto.createHash("sha256").update(buf2).digest("hex");
      if (d1 === d2) {
        matchedFiles++;
      } else {
        mismatchedContent++;
      }
    }
  }

  const parity =
    !parsedTree.truncated &&
    htmlBlobs.length > 0 &&
    lane1Results.size === htmlBlobs.length &&
    lane2Results.size === htmlBlobs.length &&
    htmlBlobs.every((b: any) => {
      const left = lane1Results.get(b.path);
      const right = lane2Results.get(b.path);
      if (left === undefined || right === undefined) return false;
      const d1 = crypto.createHash("sha256").update(left).digest("hex");
      const d2 = crypto.createHash("sha256").update(right).digest("hex");
      return d1 === d2;
    });

  if (!parity) {
    throw new Error(
      `PARITY FAILURE: Candidate set mismatch (Tree: ${htmlBlobs.length}, Lane 1: ${lane1Results.size}, Lane 2: ${lane2Results.size}, Matched: ${matchedFiles}, Mismatches: ${mismatchedContent})`
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
