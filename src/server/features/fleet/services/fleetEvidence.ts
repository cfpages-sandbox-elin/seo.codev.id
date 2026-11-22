import { createHash } from "node:crypto";
import type { RawFleetSnapshot } from "../repositories/FleetRepository";
import type { SnapshotAttemptOverlay } from "./fleetObservations";
import {
  FRESHNESS_WINDOW_MS,
  COMPARABLE_BASELINE_WINDOW_MS,
  parseUtcTimestampMs,
  measuredPercent,
} from "./fleetConstants";

export {
  FRESHNESS_WINDOW_MS,
  COMPARABLE_BASELINE_WINDOW_MS,
  parseUtcTimestampMs,
  measuredPercent,
};

// PRD §3: Essential critical incidents eligible for 59/F score cap.
// Note: Security challenges / provider blocking alone are excluded from essential caps (Sol R16 F02).
export const ESSENTIAL_INCIDENT_CODES = new Set([
  "dns_failure",
  "tls_invalid",
  "tcp_timeout",
  "http_5xx",
  "empty_body",
  "malware_defacement",
  "site_down",
]);

export interface ProvisionalRange {
  lower: number;
  upper: number;
}

/**
 * Computes provisional interval [L, U] when coverage is in [80, 100) per PRD §3 (Sol F02, R16 F04).
 * Strictly requires verified earned mass (provisionalLower or score <= coverage) and validates that
 * endpoints match expected coverage width [L, L + 100 - C] without premature integer truncation.
 */
export function computeProvisionalRange(
  snap: RawFleetSnapshot | SnapshotAttemptOverlay,
  confirmedCap = false,
): ProvisionalRange | null {
  const coverage = measuredPercent(snap.coverage);
  if (coverage === null || coverage < 80 || coverage >= 100) {
    return null;
  }

  // Sol F02: Determine verified earned mass L
  let L: number | null = null;
  if (
    snap.provisionalLower !== null &&
    snap.provisionalLower !== undefined &&
    Number.isFinite(snap.provisionalLower) &&
    snap.provisionalLower >= 0 &&
    snap.provisionalLower <= coverage
  ) {
    L = snap.provisionalLower;
  } else if (
    snap.score !== null &&
    snap.score !== undefined &&
    Number.isFinite(snap.score) &&
    snap.score >= 0 &&
    snap.score <= coverage
  ) {
    // Verified earned score mass from published snapshot score (Sol F02)
    L = snap.score;
  }

  if (L === null) {
    return null;
  }

  const expectedU = L + (100 - coverage);
  if (
    snap.provisionalUpper !== null &&
    snap.provisionalUpper !== undefined &&
    Number.isFinite(snap.provisionalUpper)
  ) {
    if (snap.provisionalLower !== null && snap.provisionalLower >= 0) {
      if (Math.abs(snap.provisionalUpper - expectedU) > 1) {
        return null;
      }
    }
  }

  const cap = confirmedCap ? 59 : 100;
  return {
    lower: Math.min(L, cap),
    upper: Math.min(expectedU, cap),
  };
}

interface ProbeEvidence {
  id: string;
  source: string;
  confirmedAtMs: number;
}

function parseProbe(raw: unknown): ProbeEvidence | null {
  if (!isRecord(raw)) return null;
  const id =
    typeof raw.id === "string"
      ? raw.id.trim()
      : typeof raw.probeId === "string"
        ? raw.probeId.trim()
        : "";
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  let confirmedAtMs =
    typeof raw.confirmedAtMs === "number" ? raw.confirmedAtMs : NaN;
  if (isNaN(confirmedAtMs) && typeof raw.confirmedAt === "string") {
    confirmedAtMs = parseUtcTimestampMs(raw.confirmedAt);
  }
  if (!id || !source) return null;
  return { id, source, confirmedAtMs };
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Validates independent confirmation of critical incidents per PRD §3 (Sol F03, R16 F02).
 * Requires eligible failure family, strict expected intent verification, independent
 * probe identities and contexts, and timestamp freshness against reference observation time.
 * Zero time inheritance: both probes must provide their own finite timestamps.
 */
export function parseIncidentConfirmation(
  snap?: {
    hasIncidentCap?: boolean | null;
    incidentReason?: string | null;
    observedAt?: string | null;
  } | null,
  referenceTimeMs = Date.now(),
): boolean {
  if (!snap || !snap.hasIncidentCap || !snap.incidentReason?.trim()) {
    return false;
  }

  const observedAtMs = parseUtcTimestampMs(snap.observedAt);
  const trimmed = snap.incidentReason.trim();

  // Require strictly validated structured JSON verification (Sol F03, R16 F02)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        return false;
      }
      const kind =
        typeof parsed.kind === "string" ? parsed.kind.toLowerCase() : "";
      if (
        !ESSENTIAL_INCIDENT_CODES.has(kind) ||
        parsed.expectedIntentVerified !== true
      ) {
        return false;
      }

      const primary = parseProbe(parsed.primaryProbe ?? parsed.probe);
      const corroboration = parseProbe(
        parsed.corroborationProbe ?? parsed.corroboration,
      );
      if (!primary || !corroboration) {
        return false;
      }

      if (
        primary.id === corroboration.id ||
        primary.source === corroboration.source
      ) {
        return false;
      }

      // Zero time inheritance: both probes must supply their own finite timestamps (Sol R16 F02)
      if (!Number.isFinite(primary.confirmedAtMs)) return false;
      if (!Number.isFinite(corroboration.confirmedAtMs)) return false;

      const oldest = Math.min(
        primary.confirmedAtMs,
        corroboration.confirmedAtMs,
      );
      const newest = Math.max(
        primary.confirmedAtMs,
        corroboration.confirmedAtMs,
      );

      return (
        Number.isFinite(observedAtMs) &&
        Number.isFinite(referenceTimeMs) &&
        Number.isFinite(oldest) &&
        newest <= observedAtMs &&
        observedAtMs <= referenceTimeMs &&
        oldest >= referenceTimeMs - FRESHNESS_WINDOW_MS
      );
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Computes canonical comparison key from validated parameters per PRD §4 (Sol F04).
 */
export function computeVerifiedComparisonKey(inputs: {
  projectId: string;
  canonicalOrigin: string;
  rubricVersion?: string;
  panelHash?: string;
  applicabilityWeightsHash?: string;
  collectorVersion?: string;
  metricVersion?: string;
  labProfileHash?: string;
  sourceScope?: string;
}): string {
  const comparisonInputs = [
    "weekly-comparison-v1",
    inputs.projectId,
    inputs.canonicalOrigin,
    inputs.rubricVersion ?? "v1",
    inputs.panelHash ?? "default-panel",
    inputs.applicabilityWeightsHash ?? "default-weights",
    inputs.collectorVersion ?? "v1",
    inputs.metricVersion ?? "v1",
    inputs.labProfileHash ?? "default-profile",
    inputs.sourceScope ?? "origin",
  ] as const;
  return createHash("sha256")
    .update(JSON.stringify(comparisonInputs))
    .digest("hex");
}

/**
 * Validates that a comparability key has verified provenance and is not an arbitrary placeholder (Sol F04).
 */
export function isValidVerifiedComparabilityKey(
  key: string | null | undefined,
): key is string {
  if (!key) return false;
  const trimmed = key.trim();
  if (
    trimmed === "*" ||
    trimmed.length < 32 ||
    trimmed.toLowerCase().includes("placeholder") ||
    trimmed.toLowerCase().includes("default")
  ) {
    return false;
  }
  return /^[a-f0-9]{64}$/i.test(trimmed);
}
