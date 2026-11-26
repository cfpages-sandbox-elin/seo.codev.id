import { sort } from "remeda";

export const FRESHNESS_WINDOW_MS = 10 * 86_400_000; // 10 days in milliseconds
export const COMPARABLE_BASELINE_WINDOW_MS = 21 * 86_400_000; // 21 days in milliseconds

type FleetOfficialGrade = "A" | "B" | "C" | "D" | "F";

const RUBRIC_V1_WEIGHTS = {
  technical: 35,
  mobilePerf: 15,
  schema: 10,
  onPage: 15,
  ai: 5,
  links: 20,
} as const;

export function gradeFor(score: number): FleetOfficialGrade {
  const n = Math.floor(score);
  if (n >= 90) return "A";
  if (n >= 80) return "B";
  if (n >= 70) return "C";
  if (n >= 60) return "D";
  return "F";
}

export function calculateMedian(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const sorted = sort(scores, (a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) {
    return sorted[Math.floor(n / 2)] ?? null;
  }
  const mid = n / 2;
  const v1 = sorted[mid - 1] ?? 0;
  const v2 = sorted[mid] ?? 0;
  const mean = (v1 + v2) / 2;
  return Math.round(mean * 10) / 10;
}

type Fraction = { n: bigint; d: bigint };

function fraction(n: bigint, d: bigint): Fraction {
  if (d <= 0n) throw new RangeError("Expected a positive denominator");
  let a = n < 0n ? -n : n;
  let b = d;
  while (b !== 0n) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}

const addFractions = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.n * b.d + b.n * a.d, a.d * b.d);

const multiplyFractions = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.n * b.n, a.d * b.d);

function numberToFraction(val: number): Fraction {
  if (!Number.isFinite(val)) {
    throw new RangeError(`Expected finite number, received ${String(val)}`);
  }
  if (Number.isInteger(val)) {
    return { n: BigInt(val), d: 1n };
  }
  const str = val.toString();
  const expMatch = /^([+-]?\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(str);
  if (expMatch) {
    const sign = expMatch[1].startsWith("-") ? -1n : 1n;
    const intDigits = expMatch[1].replace(/^[+-]/, "");
    const fracDigits = expMatch[2] ?? "";
    const digits = BigInt(intDigits + fracDigits);
    const shift = Number(expMatch[3]) - fracDigits.length;
    if (shift >= 0) {
      return { n: sign * digits * 10n ** BigInt(shift), d: 1n };
    }
    return fraction(sign * digits, 10n ** BigInt(-shift));
  }
  const dot = str.indexOf(".");
  if (dot === -1) {
    return { n: BigInt(str), d: 1n };
  }
  const decimals = str.slice(dot + 1);
  const d = 10n ** BigInt(decimals.length);
  const n = BigInt(str.slice(0, dot)) * d + BigInt(decimals);
  return fraction(n, d);
}

/**
 * Validates range [0, 100] preserving 0 and rejecting out-of-bounds/NaN/invalids (Sol F06).
 */
export function measuredPercent(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 100) {
    return null;
  }
  return value;
}

const CANONICAL_DOMAIN_REGEX =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Validates canonical FQDN hostname format per RFC 1123/3696 and WHATWG URL normalization:
 * rejects dotted numeric/octal IPv4 literals (e.g. '192.0.2.01') whose TLD is all-digits
 * or whose WHATWG URL hostname normalizes differently from its lowercased input.
 */
export function isValidCanonicalHostname(domain: string): boolean {
  if (!domain || typeof domain !== "string" || domain.length > 253) {
    return false;
  }
  if (!CANONICAL_DOMAIN_REGEX.test(domain)) {
    return false;
  }
  const lower = domain.toLowerCase();
  const labels = lower.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(tld)) {
    return false;
  }
  try {
    return new URL(`https://${domain}`).hostname === lower;
  } catch {
    return false;
  }
}

const utf8Encoder = new TextEncoder();

/**
 * Exact UTF-8 bytewise comparison matching SQLite BINARY and PostgreSQL "C" collation (Sol R2).
 */
export function compareUtf8Binary(a: string, b: string): number {
  if (a === b) return 0;
  const bytesA = utf8Encoder.encode(a);
  const bytesB = utf8Encoder.encode(b);
  const minLen = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < minLen; i++) {
    const diff = bytesA[i] - bytesB[i];
    if (diff !== 0) return diff;
  }
  return bytesA.length - bytesB.length;
}

/**
 * Shared SQLite UTC timestamp parser/validator matching parseUtcTimestampMs (Sol R1, V4-03).
 * Accepts valid calendar 0001-9999 YYYY-MM-DD HH:MM:SS(.sss)? or YYYY-MM-DDTHH:MM:SS(.sss)?Z
 * with hour 00-23, uppercase 'Z' only (GLOB), and zero NUL bytes.
 */
export function sqliteUtcTimeSql(col: string): string {
  return `(CASE WHEN instr(${col}, char(0)) = 0 AND substr(${col}, 1, 4) > '0000' AND substr(${col}, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(${col}, 12, 2) < '24' AND substr(${col}, 1, 19) = strftime('%Y-%m-%d %H:%M:%S', substr(${col}, 1, 19)) AND (length(${col}) = 19 OR (length(${col}) BETWEEN 21 AND 23 AND substr(${col}, 20) GLOB '.[0-9]*' AND substr(${col}, 21) NOT GLOB '*[^0-9]*')) AND julianday(${col}) IS NOT NULL THEN julianday(${col}) WHEN instr(${col}, char(0)) = 0 AND substr(${col}, 1, 4) > '0000' AND ${col} GLOB '*Z' AND substr(${col}, 1, 19) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]' AND substr(${col}, 12, 2) < '24' AND substr(${col}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${col}, 1, 19)) AND (length(${col}) = 20 OR (length(${col}) BETWEEN 22 AND 24 AND substr(${col}, 20, length(${col}) - 20) GLOB '.[0-9]*' AND substr(${col}, 21, length(${col}) - 21) NOT GLOB '*[^0-9]*')) AND julianday(${col}) IS NOT NULL THEN julianday(${col}) ELSE NULL END)`;
}

/**
 * Shared PostgreSQL UTC timestamp parser/validator matching parseUtcTimestampMs (Sol R1, V4-03).
 * Accepts valid calendar 0001-9999 YYYY-MM-DD HH:MM:SS(.sss)? or YYYY-MM-DDTHH:MM:SS(.sss)?Z with hour 00-23.
 */
export function pgUtcTimeSql(col: string): string {
  return `(CASE WHEN substr(${col}, 1, 4) > '0000' AND ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?$' AND pg_input_is_valid(${col} || '+00', 'timestamptz') THEN (${col} || '+00')::timestamptz WHEN substr(${col}, 1, 4) > '0000' AND ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,3})?Z$' AND pg_input_is_valid(${col}, 'timestamptz') THEN (${col})::timestamptz ELSE NULL END)`;
}

/**
 * Strict round-trip parser for observed migration formats (Sol F05, R1, V4-03):
 * Accepts 0001-9999 SQLite space-delimited text ("YYYY-MM-DD HH:MM:SS(.sss)?") or uppercase ISO-8601 strings with Z,
 * rejecting year 0000, lowercase z, NUL bytes, unzoned T timestamps, timezone offsets, 24:00:00, and rollover dates.
 */
export function parseUtcTimestampMs(value?: string | null): number {
  if (!value || value.includes("\0")) return NaN;
  const m =
    /^(\d{4}-\d{2}-\d{2})([ T])(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z)?$/.exec(
      value,
    );
  if (
    !m ||
    m[1].startsWith("0000-") ||
    (m[2] === "T" && !m[5]) ||
    (m[2] === " " && m[5])
  ) {
    return NaN;
  }
  const iso = m[1] + "T" + m[3] + "." + (m[4] ?? "").padEnd(3, "0") + "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : NaN;
}

/**
 * Exact Rubric v1 integer arithmetic using rational fractions per PRD §3 (Sol F04).
 */
export function computeCanonicalRubricV1Score(pillars: {
  technical: number;
  mobilePerf: number;
  schema: number;
  onPage: number;
  ai: number;
  links: number;
}): {
  numerator: number;
  exactScore: number;
  flooredScore: number;
  grade: FleetOfficialGrade;
} {
  const pTech = multiplyFractions(
    numberToFraction(pillars.technical),
    fraction(BigInt(RUBRIC_V1_WEIGHTS.technical), 100n),
  );
  const pMob = multiplyFractions(
    numberToFraction(pillars.mobilePerf),
    fraction(BigInt(RUBRIC_V1_WEIGHTS.mobilePerf), 100n),
  );
  const pSch = multiplyFractions(
    numberToFraction(pillars.schema),
    fraction(BigInt(RUBRIC_V1_WEIGHTS.schema), 100n),
  );
  const pOnP = multiplyFractions(
    numberToFraction(pillars.onPage),
    fraction(BigInt(RUBRIC_V1_WEIGHTS.onPage), 100n),
  );
  const pAi = multiplyFractions(
    numberToFraction(pillars.ai),
    fraction(BigInt(RUBRIC_V1_WEIGHTS.ai), 100n),
  );
  const pLink = multiplyFractions(
    numberToFraction(pillars.links),
    fraction(BigInt(RUBRIC_V1_WEIGHTS.links), 100n),
  );

  const total = addFractions(
    addFractions(addFractions(pTech, pMob), addFractions(pSch, pOnP)),
    addFractions(pAi, pLink),
  );

  const exactScore = Number(total.n) / Number(total.d);
  const flooredScore = Number(total.n / total.d);
  const grade = gradeFor(flooredScore);
  const numerator = Number((total.n * 10000n) / total.d);

  return { numerator, exactScore, flooredScore, grade };
}
