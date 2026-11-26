import { and, eq, sql } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { fleetRuns, fleetRunItems, fleetSnapshots } from "@/db/schema";
import { officialPoint } from "../services/fleetCalculations";
import {
  compareUtf8Binary,
  parseUtcTimestampMs,
  pgUtcTimeSql,
  sqliteUtcTimeSql,
} from "../services/fleetConstants";
import type {
  RawFleetMember,
  RawFleetSnapshotWithAttempt,
} from "./FleetRepository";

const pgSafeTs = pgUtcTimeSql;
const sqliteSafeTs = sqliteUtcTimeSql;

const RAW_WEIGHTED_EXPR =
  "(35.0 * fs.score_technical + 15.0 * fs.score_mobile_perf + 10.0 * fs.score_schema + 15.0 * fs.score_on_page + 5.0 * fs.score_ai_readiness + 20.0 * fs.score_internal_links) / 100.0";

function gradeMatchFor(floorExpr: string): string {
  return `fs.grade = (CASE WHEN ${floorExpr} >= 90 THEN 'A' WHEN ${floorExpr} >= 80 THEN 'B' WHEN ${floorExpr} >= 70 THEN 'C' WHEN ${floorExpr} >= 60 THEN 'D' ELSE 'F' END)`;
}

function pgProbeOkSql(p: string): string {
  return `jsonb_typeof(${p}) = 'object' AND coalesce(nullif(trim(${p}->>'id'), ''), nullif(trim(${p}->>'probeId'), '')) IS NOT NULL AND nullif(trim(${p}->>'source'), '') IS NOT NULL AND (jsonb_typeof(${p}->'confirmedAtMs') = 'number' OR nullif(trim(${p}->>'confirmedAt'), '') IS NOT NULL)`;
}

function sqliteProbeOkSql(p: string): string {
  return `json_valid(${p}) = 1 AND json_type(${p}) = 'object' AND length(trim(coalesce(nullif(trim(coalesce(json_extract(${p}, '$.id'), '')), ''), json_extract(${p}, '$.probeId'), ''))) > 0 AND length(trim(coalesce(json_extract(${p}, '$.source'), ''))) > 0 AND (typeof(json_extract(${p}, '$.confirmedAtMs')) IN ('integer', 'real') OR length(trim(coalesce(json_extract(${p}, '$.confirmedAt'), ''))) > 0)`;
}

export function buildFsPlausibleOfficialSql(isPg: boolean) {
  if (isPg) {
    const floorU = `FLOOR(((${RAW_WEIGHTED_EXPR})::numeric + 1e-12))::int`;
    const primary =
      "coalesce((fs.incident_reason)::jsonb->'primaryProbe', (fs.incident_reason)::jsonb->'probe')";
    const corrob =
      "coalesce((fs.incident_reason)::jsonb->'corroborationProbe', (fs.incident_reason)::jsonb->'corroboration')";
    const capSql = `(CASE WHEN fs.has_incident_cap = TRUE AND fs.score <= 59 AND fs.incident_reason IS NOT NULL AND left(trim(fs.incident_reason), 1) = '{' AND right(trim(fs.incident_reason), 1) = '}' AND pg_input_is_valid(fs.incident_reason, 'jsonb') THEN (CASE WHEN jsonb_typeof((fs.incident_reason)::jsonb) = 'object' AND lower(coalesce((fs.incident_reason)::jsonb->>'kind', '')) IN ('dns_failure','tls_invalid','tcp_timeout','http_5xx','empty_body','malware_defacement','site_down') AND jsonb_typeof((fs.incident_reason)::jsonb->'expectedIntentVerified') = 'boolean' AND ((fs.incident_reason)::jsonb->'expectedIntentVerified') = 'true'::jsonb AND ${pgProbeOkSql(primary)} AND ${pgProbeOkSql(corrob)} AND coalesce(nullif(trim(${primary}->>'id'), ''), nullif(trim(${primary}->>'probeId'), '')) <> coalesce(nullif(trim(${corrob}->>'id'), ''), nullif(trim(${corrob}->>'probeId'), '')) AND trim(${primary}->>'source') <> trim(${corrob}->>'source') THEN TRUE ELSE FALSE END) ELSE FALSE END)`;
    return sql.raw(
      `(fri.status = 'completed' AND fr.rubric_version = 'v1' AND fs.coverage = 100 AND NOT fs.is_provisional AND fs.score BETWEEN 0 AND 100 AND fs.score_technical BETWEEN 0 AND 100 AND fs.score_internal_links BETWEEN 0 AND 100 AND fs.score_mobile_perf BETWEEN 0 AND 100 AND fs.score_on_page BETWEEN 0 AND 100 AND fs.score_schema BETWEEN 0 AND 100 AND fs.score_ai_readiness BETWEEN 0 AND 100 AND ((NOT fs.has_incident_cap AND (fs.score = ${floorU} OR ABS((${RAW_WEIGHTED_EXPR}) - fs.score) < 1e-7) AND ${gradeMatchFor(floorU)}) OR (${capSql} AND (fs.score = LEAST(59, ${floorU}) OR ABS(LEAST(59, ${RAW_WEIGHTED_EXPR}) - fs.score) < 1e-7) AND ${gradeMatchFor(`LEAST(59, ${floorU})`)}) OR (fs.has_incident_cap AND fs.score <= 59 AND (fs.score = ${floorU} OR ABS((${RAW_WEIGHTED_EXPR}) - fs.score) < 1e-7) AND ${gradeMatchFor(floorU)})))`,
    );
  }
  const floorU = `CAST(((${RAW_WEIGHTED_EXPR}) + 1e-12) AS INTEGER)`;
  const primary =
    "coalesce(json_extract(fs.incident_reason, '$.primaryProbe'), json_extract(fs.incident_reason, '$.probe'))";
  const corrob =
    "coalesce(json_extract(fs.incident_reason, '$.corroborationProbe'), json_extract(fs.incident_reason, '$.corroboration'))";
  const capSql = `(CASE WHEN fs.has_incident_cap = 1 AND fs.score <= 59 AND fs.incident_reason IS NOT NULL AND json_valid(fs.incident_reason) = 1 THEN (CASE WHEN json_type(fs.incident_reason) = 'object' AND lower(coalesce(json_extract(fs.incident_reason, '$.kind'), '')) IN ('dns_failure','tls_invalid','tcp_timeout','http_5xx','empty_body','malware_defacement','site_down') AND json_type(fs.incident_reason, '$.expectedIntentVerified') = 'true' AND ${sqliteProbeOkSql(primary)} AND ${sqliteProbeOkSql(corrob)} AND trim(coalesce(nullif(trim(coalesce(json_extract(${primary}, '$.id'), '')), ''), json_extract(${primary}, '$.probeId'), '')) <> trim(coalesce(nullif(trim(coalesce(json_extract(${corrob}, '$.id'), '')), ''), json_extract(${corrob}, '$.probeId'), '')) AND trim(json_extract(${primary}, '$.source')) <> trim(json_extract(${corrob}, '$.source')) THEN 1 ELSE 0 END) ELSE 0 END)`;
  return sql.raw(
    `(fri.status = 'completed' AND fr.rubric_version = 'v1' AND fs.coverage = 100 AND fs.is_provisional = 0 AND fs.score BETWEEN 0 AND 100 AND fs.score_technical BETWEEN 0 AND 100 AND fs.score_internal_links BETWEEN 0 AND 100 AND fs.score_mobile_perf BETWEEN 0 AND 100 AND fs.score_on_page BETWEEN 0 AND 100 AND fs.score_schema BETWEEN 0 AND 100 AND fs.score_ai_readiness BETWEEN 0 AND 100 AND ((fs.has_incident_cap = 0 AND (fs.score = ${floorU} OR ABS((${RAW_WEIGHTED_EXPR}) - fs.score) < 1e-7) AND ${gradeMatchFor(floorU)}) OR (${capSql} = 1 AND (fs.score = MIN(59, ${floorU}) OR ABS(MIN(59, ${RAW_WEIGHTED_EXPR}) - fs.score) < 1e-7) AND ${gradeMatchFor(`MIN(59, ${floorU})`)}) OR (fs.has_incident_cap = 1 AND fs.score <= 59 AND (fs.score = ${floorU} OR ABS((${RAW_WEIGHTED_EXPR}) - fs.score) < 1e-7) AND ${gradeMatchFor(floorU)})))`,
  );
}

export const snapshotSelectColumns = {
  id: fleetSnapshots.id,
  runItemId: fleetSnapshots.runItemId,
  memberId: fleetSnapshots.memberId,
  projectId: fleetSnapshots.projectId,
  canonicalHost: fleetSnapshots.canonicalHost,
  score: fleetSnapshots.score,
  grade: fleetSnapshots.grade,
  coverage: fleetSnapshots.coverage,
  isProvisional: fleetSnapshots.isProvisional,
  provisionalLower: fleetSnapshots.provisionalLower,
  provisionalUpper: fleetSnapshots.provisionalUpper,
  hasIncidentCap: fleetSnapshots.hasIncidentCap,
  incidentReason: fleetSnapshots.incidentReason,
  scoreTechnical: fleetSnapshots.scoreTechnical,
  scoreInternalLinks: fleetSnapshots.scoreInternalLinks,
  scoreMobilePerf: fleetSnapshots.scoreMobilePerf,
  scoreOnPage: fleetSnapshots.scoreOnPage,
  scoreSchema: fleetSnapshots.scoreSchema,
  scoreAiReadiness: fleetSnapshots.scoreAiReadiness,
  seriesKey: fleetSnapshots.seriesKey,
  comparabilityKey: fleetSnapshots.comparabilityKey,
  evidenceManifestR2Key: fleetSnapshots.evidenceManifestR2Key,
  evidenceManifestHash: fleetSnapshots.evidenceManifestHash,
  observedAt: fleetSnapshots.observedAt,
  attemptOutcome: fleetRunItems.status,
  attemptStatus: fleetRunItems.status,
  runId: fleetRunItems.runId,
  errorCode: fleetRunItems.errorCode,
  rubricVersion: fleetRuns.rubricVersion,
  runItemMemberId: fleetRunItems.memberId,
  runItemProjectId: fleetRunItems.projectId,
};

type RawSnapshotJoinRow = {
  runItemMemberId: string;
  runItemProjectId: string | null;
} & RawFleetSnapshotWithAttempt;

export function normalizeSnapshotRow(
  row: RawSnapshotJoinRow,
): RawFleetSnapshotWithAttempt | null {
  if (
    row.memberId !== row.runItemMemberId ||
    row.projectId !== row.runItemProjectId
  ) {
    return null;
  }
  return {
    ...row,
    attemptStatus: row.attemptStatus ?? null,
    errorCode: row.errorCode ?? null,
    comparabilityKey: row.comparabilityKey ?? null,
    seriesKey: row.seriesKey ?? null,
    rubricVersion: row.rubricVersion ?? null,
  };
}

function appendRecoveryPage(opts: {
  page: RawSnapshotJoinRow[];
  member: RawFleetMember;
  nowMs: number;
  snapshots: RawFleetSnapshotWithAttempt[];
  seenSnapIds: Set<string>;
  recoveredRunItemIds: Set<string>;
}): number {
  const { page, member, nowMs, snapshots, seenSnapIds, recoveredRunItemIds } =
    opts;
  let addedValid = 0;
  for (const row of page) {
    if (seenSnapIds.has(row.id)) continue;
    const candidate = normalizeSnapshotRow(row);
    if (!candidate) continue;
    seenSnapIds.add(row.id);
    snapshots.push(candidate);
    recoveredRunItemIds.add(row.runItemId);
    if (
      officialPoint(
        candidate,
        member.projectId,
        nowMs,
        candidate.attemptStatus,
        member.canonicalHost,
      ) !== null
    ) {
      addedValid++;
    }
  }
  return addedValid;
}

/**
 * Bounded keyset continuation sweep when a member fills its initial 30-row weekly window
 * with < 2 JS-verified officialPoint observations (Sol R31 V4-01).
 */
export async function recoverMemberWeeklyBaselines(params: {
  member: RawFleetMember;
  organizationId: string;
  versionId: string;
  isPg: boolean;
  nowMs: number;
  nowIso: string;
  snapshots: RawFleetSnapshotWithAttempt[];
  seenSnapIds: Set<string>;
  recoveredRunItemIds: Set<string>;
}): Promise<void> {
  const {
    member,
    organizationId,
    versionId,
    isPg,
    nowMs,
    nowIso,
    snapshots,
    seenSnapIds,
    recoveredRunItemIds,
  } = params;
  if (!member.projectId || member.enrollmentState !== "active") return;

  const weeklyCompleted = snapshots.filter(
    (s) =>
      s.memberId === member.id &&
      s.projectId === member.projectId &&
      s.seriesKey === "weekly-baseline" &&
      s.attemptStatus === "completed",
  );
  if (weeklyCompleted.length < 30) return;

  let validOfficialCount = weeklyCompleted.filter(
    (s) =>
      officialPoint(
        s,
        member.projectId,
        nowMs,
        s.attemptStatus,
        member.canonicalHost,
      ) !== null,
  ).length;
  if (validOfficialCount >= 2) return;

  const sortedAsc = sort(weeklyCompleted, (a, b) => {
    const ta = parseUtcTimestampMs(a.observedAt);
    const tb = parseUtcTimestampMs(b.observedAt);
    const diff =
      (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
    return diff !== 0 ? diff : compareUtf8Binary(a.id, b.id);
  });
  let cursorObserved: string | null = sortedAsc[0]?.observedAt ?? null;
  let cursorId: string | null = sortedAsc[0]?.id ?? null;

  const observedExpr = isPg
    ? sql.raw(pgSafeTs("fleet_snapshots.observed_at"))
    : sql.raw(sqliteSafeTs("fleet_snapshots.observed_at"));
  const nowBound = isPg
    ? sql`${nowIso}::timestamptz`
    : sql`julianday(${nowIso})`;

  for (let pageIdx = 0; pageIdx < 34 && cursorObserved && cursorId; pageIdx++) {
    const cursorMs = parseUtcTimestampMs(cursorObserved);
    if (!Number.isFinite(cursorMs)) break;
    const curId: string = cursorId;
    const cursorIso = new Date(cursorMs).toISOString();
    const cursorBound = isPg
      ? sql`${cursorIso}::timestamptz`
      : sql`julianday(${cursorIso})`;
    const cursorKeysetSql = isPg
      ? sql`(${observedExpr} < ${cursorBound} OR (${observedExpr} = ${cursorBound} AND ${fleetSnapshots.id} COLLATE "C" < ${curId}))`
      : sql`(${observedExpr} < ${cursorBound} OR (${observedExpr} = ${cursorBound} AND ${fleetSnapshots.id} COLLATE BINARY < ${curId}))`;

    const page: RawSnapshotJoinRow[] = await db
      .select(snapshotSelectColumns)
      .from(fleetSnapshots)
      .innerJoin(fleetRunItems, eq(fleetSnapshots.runItemId, fleetRunItems.id))
      .innerJoin(
        fleetRuns,
        and(
          eq(fleetRunItems.runId, fleetRuns.id),
          eq(fleetRuns.organizationId, organizationId),
          eq(fleetRuns.rosterVersionId, versionId),
        ),
      )
      .where(
        and(
          eq(fleetSnapshots.memberId, member.id),
          eq(fleetSnapshots.projectId, member.projectId),
          eq(fleetSnapshots.seriesKey, "weekly-baseline"),
          eq(fleetSnapshots.coverage, 100),
          eq(fleetSnapshots.isProvisional, false),
          eq(fleetRunItems.status, "completed"),
          eq(fleetRuns.rubricVersion, "v1"),
          sql`lower(trim(${fleetSnapshots.canonicalHost})) = lower(trim(${member.canonicalHost}))`,
          sql`(${observedExpr} IS NOT NULL AND ${observedExpr} <= ${nowBound})`,
          cursorKeysetSql,
        ),
      )
      .orderBy(
        sql`${observedExpr} DESC NULLS LAST`,
        isPg
          ? sql`${fleetSnapshots.id} COLLATE "C" DESC`
          : sql`${fleetSnapshots.id} COLLATE BINARY DESC`,
      )
      .limit(30);

    if (page.length === 0) break;
    validOfficialCount += appendRecoveryPage({
      page,
      member,
      nowMs,
      snapshots,
      seenSnapIds,
      recoveredRunItemIds,
    });
    const tail = page.at(-1);
    if (!tail) break;
    cursorObserved = tail.observedAt;
    cursorId = tail.id;
    if (page.length < 30 || validOfficialCount >= 2) break;
  }
}
