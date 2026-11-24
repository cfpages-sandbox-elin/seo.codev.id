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
  if (Number.isInteger(val)) {
    return { n: BigInt(val), d: 1n };
  }
  const str = val.toString();
  const dot = str.indexOf(".");
  if (dot === -1) {
    return { n: BigInt(str), d: 1n };
  }
  if (str.includes("e") || str.includes("E")) {
    const scale = 1_000_000_000n;
    return fraction(BigInt(Math.floor(val * 1_000_000_000)), scale);
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

/**
 * Strict round-trip parser for observed migration formats (Sol F05):
 * Accepts SQLite space-delimited text ("YYYY-MM-DD HH:MM:SS") or ISO-8601 strings with Z,
 * and rejects unzoned timestamps or impossible rollover dates.
 */
export function parseUtcTimestampMs(value?: string | null): number {
  if (!value) return NaN;
  const m =
    /^(\d{4}-\d{2}-\d{2})([ T])(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z)?$/.exec(
      value,
    );
  if (!m || (m[2] === "T" && !m[5])) return NaN;
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
