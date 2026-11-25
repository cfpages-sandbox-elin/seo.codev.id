import { sort } from "remeda";
import type {
  RawFleetRunItem,
  RawFleetSnapshot,
} from "../repositories/FleetRepository";
import {
  compareUtf8Binary,
  measuredPercent,
  parseUtcTimestampMs,
} from "./fleetCalculations";

export interface SnapshotAttemptOverlay extends RawFleetSnapshot {
  attemptStatus?: string | null;
  attemptOutcome?: string | null;
  status?: string | null;
  errorCode?: string | null;
  attemptErrorCode?: string | null;
  rubricVersion?: string | null;
}

interface AdmittedObservation {
  snap: SnapshotAttemptOverlay;
  observedAtMs: number;
  parent: {
    item: RawFleetRunItem;
    completedAtMs: number;
  };
}

export function resolveTerminalAttempts(
  scopedItems: RawFleetRunItem[],
  now: number,
) {
  const admitted = sort(
    scopedItems.flatMap((item) => {
      const completedAtMs = parseUtcTimestampMs(item.completedAt);
      const isTerminal =
        item.status === "completed" ||
        item.status === "failed" ||
        item.status === "partial";
      return isTerminal &&
        Number.isFinite(completedAtMs) &&
        completedAtMs <= now
        ? [{ item, completedAtMs }]
        : [];
    }),
    (a, b) =>
      b.completedAtMs - a.completedAtMs ||
      compareUtf8Binary(b.item.id, a.item.id),
  );
  return {
    admittedItemById: new Map(admitted.map((x) => [x.item.id, x])),
    admittedTerminalAttempts: admitted,
  };
}

export function resolveAdmittedObservations(
  memberSnaps: SnapshotAttemptOverlay[],
  memberProjectId: string | null,
  admittedItemById: Map<
    string,
    { item: RawFleetRunItem; completedAtMs: number }
  >,
  now: number,
  memberCanonicalHost?: string | null,
): AdmittedObservation[] {
  if (!memberProjectId) return [];
  return sort(
    memberSnaps.flatMap((snap) => {
      if (snap.projectId !== memberProjectId) return [];
      // Sol F01: Reject observations that belong to another host
      if (
        memberCanonicalHost &&
        snap.canonicalHost &&
        snap.canonicalHost.trim().toLowerCase() !==
          memberCanonicalHost.trim().toLowerCase()
      ) {
        return [];
      }
      const parent = admittedItemById.get(snap.runItemId);
      if (!parent || parent.item.status === "failed") return [];
      const observedAtMs = parseUtcTimestampMs(snap.observedAt);
      if (
        !Number.isFinite(observedAtMs) ||
        observedAtMs > now ||
        observedAtMs > parent.completedAtMs
      ) {
        return [];
      }
      // Sol F02: Align series identity between snapshot and parent run item
      if (
        snap.seriesKey === "weekly-baseline" &&
        parent.item.primarySeriesKey &&
        parent.item.primarySeriesKey !== "weekly-baseline"
      ) {
        return [];
      }
      return [{ snap, observedAtMs, parent }];
    }),
    (a, b) =>
      b.observedAtMs - a.observedAtMs ||
      compareUtf8Binary(b.snap.id, a.snap.id),
  );
}

export function extractPillars(
  currentSnapshot: SnapshotAttemptOverlay | null,
  hasScores: boolean,
) {
  if (!hasScores || !currentSnapshot) {
    return {
      coverage: null,
      scoreTechnical: null,
      scoreInternalLinks: null,
      scoreMobilePerf: null,
      scoreOnPage: null,
      scoreSchema: null,
      scoreAiReadiness: null,
    };
  }
  return {
    coverage: measuredPercent(currentSnapshot.coverage),
    scoreTechnical: measuredPercent(currentSnapshot.scoreTechnical),
    scoreInternalLinks: measuredPercent(currentSnapshot.scoreInternalLinks),
    scoreMobilePerf: measuredPercent(currentSnapshot.scoreMobilePerf),
    scoreOnPage: measuredPercent(currentSnapshot.scoreOnPage),
    scoreSchema: measuredPercent(currentSnapshot.scoreSchema),
    scoreAiReadiness: measuredPercent(currentSnapshot.scoreAiReadiness),
  };
}
