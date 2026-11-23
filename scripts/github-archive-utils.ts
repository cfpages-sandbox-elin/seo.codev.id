import crypto from "node:crypto";

/**
 * Streaming byte capping transform stream (Sol P1 - F1).
 * Enforces maximum byte bounds as chunks arrive without buffering the entire payload into RAM.
 */
export function capBytes(maxBytes: number, label: string): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new Error(`${label} exceeds byte limit (${seen} > ${maxBytes})`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Creates a typed gzip decompression TransformStream (Sol F1).
 */
export function decompressGzipStream(): TransformStream<Uint8Array, Uint8Array> {
  return new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>;
}

/**
 * Reads a web ReadableStream of Uint8Array into a single Buffer.
 */
export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
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
  if (!domain || typeof domain !== "string" || domain.length > 253) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain);
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

    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").trim();
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "").trim();
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;

    const slashIdx = fullName.indexOf("/");
    const relPath = slashIdx !== -1 ? fullName.slice(slashIdx + 1) : fullName;

    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
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
