import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUtcTimestampMs } from "../src/server/features/fleet/services/fleetConstants";
import { isValidRepoSlug, normalizeGitRelativePath } from "../src/shared/git-repo";
export { isValidRepoSlug, normalizeGitRelativePath };

/**
 * Streaming byte capping transform stream (Sol P1 - F1).
 * Enforces maximum byte bounds as chunks arrive without buffering the entire payload into RAM.
 */
export function capBytes(
  maxBytes: number,
  label: string,
): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new Error(`${label} exceeds byte limit (${seen} > ${maxBytes})`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Creates a typed gzip decompression TransformStream (Sol F1).
 */
export function decompressGzipStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  return new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
}

/**
 * Reads a web ReadableStream of Uint8Array into a single Buffer.
 */
export async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Cryptographic Git Blob Identity Verification (Sol P1 - F2).
 * Verifies that the raw bytes match Git's object ID: `blob <len>\0<bytes>`.
 */
export function verifyGitBlob(bytes: Buffer, expectedSha: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedSha)) {
    throw new Error(`Invalid Git blob ID: ${expectedSha}`);
  }
  const algorithm = expectedSha.length === 64 ? "sha256" : "sha1";
  const actualSha = crypto
    .createHash(algorithm)
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(
      `Git blob identity mismatch: expected ${expectedSha}, got ${actualSha} (${bytes.length} bytes)`,
    );
  }
}

/**
 * Validates canonical hostname format per RFC 1123 (Sol F6).
 * Accepts labels of length 1-63 without leading/trailing hyphens, capped at 253 chars total.
 */
export function isValidCanonicalHostname(domain: string): boolean {
  if (!domain || typeof domain !== "string" || domain.length > 253)
    return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
    domain,
  );
}


export interface GitTreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export interface DiscoveredGitTree {
  defaultBranch: string;
  commitSha: string;
  tree: GitTreeItem[];
}

/**
 * Discovers Git Tree via GitHub API CLI with zero shell interpolation (Sol P1-04).
 * Enforces literal argument arrays, URL segment encoding, commit SHA validation,
 * and fail-closed tree truncation checks.
 */
export type GitHubHeadDescriptor = Readonly<{
  repoName: string;
  branch: string;
  commitSha: string;
  treeSha: string;
}>;

/**
 * Resolves the repository default branch, pinned commit SHA, and immutable root tree SHA.
 */
export function resolveGitHubHead(
  repoName: string,
  options?: { branch?: string; timeoutMs?: number },
): GitHubHeadDescriptor {
  if (!isValidRepoSlug(repoName)) {
    throw new Error(
      `Invalid GitHub repository slug: "${repoName}". Must match owner/repo pattern.`,
    );
  }

  const [owner, repo] = repoName.split("/");
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const ghExe = process.platform === "win32" ? "gh.exe" : "gh";
  const timeoutMs = options?.timeoutMs ?? 30_000;

  // 1. Resolve default branch if not specified
  let branch: string = options?.branch ?? "";
  if (!branch) {
    const repoRaw = execFileSync(ghExe, ["api", base], {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const repoJson = JSON.parse(repoRaw);
    branch = String(repoJson.default_branch || "main");
  }

  // 2. Fetch pinned commit SHA and tree SHA for branch
  const commitRaw = execFileSync(
    ghExe,
    ["api", `${base}/commits/${encodeURIComponent(branch)}`],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const commitJson = JSON.parse(commitRaw);
  const commitSha = String(commitJson.sha || "");
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error(`Invalid commit SHA returned by GitHub: ${commitSha}`);
  }
  const treeSha = String(commitJson.commit?.tree?.sha || "");
  if (!/^[a-f0-9]{40}$/i.test(treeSha)) {
    throw new Error(`Invalid tree SHA returned by GitHub: ${treeSha}`);
  }

  return { repoName, branch, commitSha, treeSha };
}

/**
 * Fetch recursive git tree using immutable tree SHA from Head descriptor (Sol A1, Round 17).
 */
export function fetchGitHubTree(
  head: GitHubHeadDescriptor,
  options?: { timeoutMs?: number },
): DiscoveredGitTree {
  const [owner, repo] = head.repoName.split("/");
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const ghExe = process.platform === "win32" ? "gh.exe" : "gh";
  const timeoutMs = options?.timeoutMs ?? 30_000;

  // Fetch recursive git tree for commit by immutable tree SHA
  const treeRaw = execFileSync(
    ghExe,
    ["api", `${base}/git/trees/${encodeURIComponent(head.treeSha)}?recursive=1`],
    {
      encoding: "utf8",
      timeout: Math.max(timeoutMs, 60_000),
      shell: false,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const treeJson = JSON.parse(treeRaw);
  if (!treeJson || typeof treeJson !== "object") {
    throw new Error(
      `MALFORMED_TREE_RESPONSE: GitHub returned non-object JSON for ${head.repoName}`,
    );
  }
  if (treeJson.truncated !== false) {
    throw new Error(
      `DISCOVERY_TRUNCATED: Git tree for ${head.repoName} is truncated by GitHub (truncated=${treeJson.truncated}); recursive subtree enumeration required`,
    );
  }
  if (!treeJson.sha || treeJson.sha.toLowerCase() !== head.treeSha.toLowerCase()) {
    throw new Error(
      `TREE_SHA_MISMATCH: Expected root tree SHA ${head.treeSha} but received ${treeJson?.sha ?? "missing"}`,
    );
  }
  if (!Array.isArray(treeJson.tree)) {
    throw new Error(
      `MALFORMED_TREE_RESPONSE: GitHub response missing 'tree' array for ${head.repoName}`,
    );
  }

  return {
    defaultBranch: head.branch,
    commitSha: head.commitSha,
    tree: treeJson.tree,
  };
}


/**
 * Discover the repository default branch, pinned commit SHA, and recursive git tree.
 */
export function discoverGitHubTree(
  repoName: string,
  options?: { branch?: string; timeoutMs?: number },
): DiscoveredGitTree {
  const head = resolveGitHubHead(repoName, options);
  return fetchGitHubTree(head, options);
}

/**
 * Selects effective approved roster version with full parity to FleetRepository.getApprovedRoster (Sol P1-03).
 * Filters approvals to valid UTC timestamps at or before clock, sorting newest first with id tie-breaker.
 */
export function selectEffectiveRosterVersion<
  T extends {
    id: string;
    approved_at?: string | null;
    approvedAt?: string | null;
    domain_count?: number | null;
  },
>(versions: T[], nowMs = Date.now()): T | null {
  if (!versions || versions.length === 0) return null;

  const valid = versions.filter((v) => {
    const raw = v.approved_at ?? v.approvedAt;
    const t = parseUtcTimestampMs(raw);
    return Number.isFinite(t) && t <= nowMs;
  });

  if (valid.length === 0) return null;

  valid.sort((a, b) => {
    const tA = parseUtcTimestampMs(a.approved_at ?? a.approvedAt);
    const tB = parseUtcTimestampMs(b.approved_at ?? b.approvedAt);
    const diff = (isNaN(tB) ? 0 : tB) - (isNaN(tA) ? 0 : tA);
    if (diff !== 0) return diff;
    return b.id.localeCompare(a.id);
  });

  return valid[0] ?? null;
}

/**
 * Robust JSON extraction from mixed stdout.
 */
export function extractJsonFromOutput(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {}

  const jsonStart = stdout.indexOf("[");
  const jsonEnd = stdout.lastIndexOf("]");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    const slice = stdout.slice(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  const objStart = stdout.indexOf("{");
  const objEnd = stdout.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const slice = stdout.slice(objStart, objEnd + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }

  return null;
}

/**
 * Loads environment variables from local config files.
 */
export function loadLocalEnv(
  repoRoot = "C:/Users/THINKPAD/Documents/GitHub/seo.codev.id",
): Record<string, string> {
  const env: Record<string, string> = {};
  const candidates = [
    resolve(repoRoot, ".env.selfhost"),
    resolve(repoRoot, ".env.local"),
    resolve(repoRoot, ".env"),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf8");
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0 && !trimmed.startsWith("#")) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed
              .slice(eqIdx + 1)
              .trim()
              .replace(/^['"]|['"]$/g, "");
            if (!env[key]) env[key] = val;
          }
        }
      } catch {}
    }
  }
  return env;
}

function windowsCommandUpperBound(argv: string[]) {
  // Quoting can at most double each character, plus surrounding quotes.
  const words = [process.execPath, ...argv];
  return words.reduce((size, word) => size + 2 * word.length + 2, words.length);
}

/**
 * Literal Hex SQL Text Encoder (Sol R1, Round 17).
 * Encodes strings into SQLite blob literals CAST(X'...' AS TEXT) to prevent
 * Wrangler CLI local command trimmers from stripping keywords or failing on SQL syntax.
 */
export function sqlText(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return "CAST(X'" + Buffer.from(value, "utf8").toString("hex") + "' AS TEXT)";
}

/**
 * Bounded D1 Multi-Statement Batch Execution via Direct Command (Sol P1-01, F3, F08).
 * Completely eliminates Wrangler D1 import path (--file) and import database locks.
 * Bounded by <= 10 statements, <= 15,000 bytes per batch envelope, and conservative Windows
 * CreateProcessW UTF-16 character limit (<= 30,000 chars) with timeout supervision.
 */
export function executeD1SqlBatches(
  statements: string[],
  isRemote = true,
  options?: {
    maxStatementsPerBatch?: number;
    maxBytesPerBatch?: number;
    repoRoot?: string;
  },
): any[] {
  if (!statements || statements.length === 0) return [];
  const dbName = isRemote ? "open-seo-db-selfhost" : "DB";
  const flag = isRemote ? "--remote" : "--local";
  const maxStatements = Math.min(
    9,
    Math.max(1, options?.maxStatementsPerBatch ?? 9),
  );
  const maxBytes = Math.min(
    14_999,
    Math.max(100, options?.maxBytesPerBatch ?? 14_999),
  );
  const defaultRepoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const repoRoot = options?.repoRoot ?? defaultRepoRoot;

  const wranglerJs = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");
  const wranglerArgs = [
    wranglerJs,
    "d1",
    "execute",
    dbName,
    flag,
    "--json",
    "--command",
  ];

  function fits(stmts: string[]) {
    const command = stmts.join("\n");
    const serializedEnvelope = JSON.stringify({ sql: command });
    return (
      stmts.length <= maxStatements &&
      Buffer.byteLength(command, "utf8") <= maxBytes &&
      Buffer.byteLength(serializedEnvelope, "utf8") <= maxBytes &&
      (process.platform !== "win32" ||
        windowsCommandUpperBound([...wranglerArgs, command]) <= 30_000)
    );
  }

  const batches: string[][] = [];
  let currentBatch: string[] = [];

  for (const rawStmt of statements) {
    const trimmed = rawStmt.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    const stmt = trimmed.endsWith(";") ? trimmed : trimmed + ";";

    if (!fits([stmt])) {
      const stmtBytes = Buffer.byteLength(stmt, "utf8");
      throw new Error(
        `D1 statement exceeds maximum batch budget constraints (${stmtBytes} bytes)`,
      );
    }

    if (currentBatch.length > 0 && !fits([...currentBatch, stmt])) {
      batches.push(currentBatch);
      currentBatch = [stmt];
    } else {
      currentBatch.push(stmt);
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  const allResults: any[] = [];
  const localEnv = loadLocalEnv(repoRoot);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const combinedSql = batch.join("\n");
    const argv = [...wranglerArgs, combinedSql];

    const result = spawnSync(process.execPath, argv, {
      cwd: repoRoot,
      env: { ...process.env, ...localEnv },
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      shell: false,
      timeout: 60_000,
    });

    if (result.error) {
      throw new Error(`Failed to invoke Wrangler D1: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `Wrangler D1 command failed with exit code ${result.status}: ${result.stderr || result.stdout}`,
      );
    }

    const parsed = extractJsonFromOutput(result.stdout);
    if (!Array.isArray(parsed) || parsed.length < batch.length) {
      throw new Error(
        `D1 execution did not return a valid result array matching batch length (${parsed?.length ?? 0} vs expected ${batch.length}) for batch ${b + 1}/${batches.length}: ${result.stdout.slice(0, 500)}`,
      );
    }

    for (let i = 0; i < batch.length; i++) {
      const stmtResult = parsed[i];
      if (!stmtResult || stmtResult.success !== true) {
        throw new Error(
          `D1 statement ${i + 1} failed in batch ${b + 1}: ${JSON.stringify(stmtResult?.errors || stmtResult)}`,
        );
      }
      if (Array.isArray(stmtResult.results)) {
        allResults.push(...stmtResult.results);
      }
    }
  }

  return allResults;
}

/**
 * Shared verified blob acquisition with cryptographic Git blob hash verification
 * and transparent raw fallback (Sol P2 - F8).
 */
export async function acquireVerifiedBlob(
  file: { path: string; sha: string },
  repoName: string,
  commitSha: string,
  archiveMap?: Map<string, Buffer> | null,
  token?: string,
): Promise<{ buffer: Buffer; fromArchive: boolean }> {
  if (archiveMap) {
    const candidate = archiveMap.get(file.path);
    if (candidate) {
      try {
        verifyGitBlob(candidate, file.sha);
        return { buffer: candidate, fromArchive: true };
      } catch {
        // Mismatched or truncated archive entry: fall through to verified raw blob lane
      }
    }
  }

  const rawPath = file.path.split("/").map(encodeURIComponent).join("/");
  const rawUrl = `https://raw.githubusercontent.com/${repoName}/${commitSha}/${rawPath}`;
  const res = await fetch(rawUrl, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "OpenSEO-Verified-Blob-Acquisition",
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status} acquiring blob for ${file.path}`);
  }
  const buf = await streamToBuffer(
    res.body.pipeThrough(capBytes(10 * 1024 * 1024, "raw blob fallback")),
  );
  verifyGitBlob(buf, file.sha);
  return { buffer: buf, fromArchive: false };
}

/**
 * Extracts HTML files from an uncompressed in-memory UStar tarball (Sol P1-02).
 */
export function parseTarHtmlFiles(
  tarBuf: Buffer,
  maxEntrySize: number = 10 * 1024 * 1024,
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

    const rawName = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const rawPrefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;

    const slashIdx = fullName.indexOf("/");
    const relPath = slashIdx !== -1 ? fullName.slice(slashIdx + 1) : fullName;

    const sizeStr = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = parseInt(sizeStr, 8);

    const typeFlag = header[156];
    const isRegularFile = typeFlag === 0 || typeFlag === 48;

    const contentStart = offset + 512;
    const contentEnd = contentStart + (isNaN(size) ? 0 : size);

    if (
      isRegularFile &&
      !isNaN(size) &&
      size <= maxEntrySize &&
      (relPath.endsWith(".html") || relPath.endsWith(".htm"))
    ) {
      if (contentEnd <= tarBuf.length) {
        const content = Buffer.from(tarBuf.subarray(contentStart, contentEnd));
        htmlMap.set(relPath, content);
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset += 512 + (isNaN(paddedSize) ? 512 : paddedSize);
  }

  return htmlMap;
}
