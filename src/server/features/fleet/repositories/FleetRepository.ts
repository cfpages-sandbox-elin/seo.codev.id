import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import {
  fleetRosterVersions,
  fleetRosterMembers,
  fleetRuns,
  fleetRunItems,
  fleetSnapshots,
  projects,
} from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { parseUtcTimestampMs } from "../services/fleetConstants";

export type RawFleetMember = typeof fleetRosterMembers.$inferSelect;
export type RawFleetSnapshot = typeof fleetSnapshots.$inferSelect;
type RawFleetVersion = typeof fleetRosterVersions.$inferSelect;
export type RawFleetRunItem = Omit<
  typeof fleetRunItems.$inferSelect,
  "leaseToken" | "leaseExpiresAt" | "errorDetail"
> & {
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  errorDetail?: string | null;
  rubricVersion?: string | null;
};

type RawFleetSnapshotWithAttempt = RawFleetSnapshot & {
  attemptStatus?: string | null;
  errorCode?: string | null;
  attemptErrorCode?: string | null;
  comparabilityKey?: string | null;
  seriesKey?: string | null;
  rubricVersion?: string | null;
};

const pgSafeTs = (col: string) =>
  `(CASE WHEN ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?$' AND pg_input_is_valid(${col} || '+00', 'timestamptz') THEN (${col} || '+00')::timestamptz WHEN ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' AND pg_input_is_valid(${col}, 'timestamptz') THEN ${col}::timestamptz ELSE NULL END)`;

const sqliteSafeTs = (col: string) =>
  `(CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' AND ${col} = strftime('%Y-%m-%d %H:%M:%S', ${col}) THEN julianday(${col}) WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z' AND substr(${col}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${col}, 1, 19)) AND (length(${col}) = 20 OR substr(${col}, 20) GLOB '.[0-9]*Z') AND julianday(${col}) IS NOT NULL THEN julianday(${col}) WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*[+-][0-9][0-9]:[0-9][0-9]' AND substr(${col}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', substr(${col}, 1, 19)) AND julianday(${col}) IS NOT NULL THEN julianday(${col}) ELSE NULL END)`;

interface RawFleetData {
  version: RawFleetVersion;
  members: RawFleetMember[];
  snapshots: RawFleetSnapshotWithAttempt[];
  runItems: RawFleetRunItem[];
}

function isProjectDomainMatch(
  liveProjectDomain: string | null | undefined,
  canonicalHost: string,
  aliasesJson: string | null,
): boolean {
  if (!liveProjectDomain) return false;
  const normProjectDomain = liveProjectDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (normProjectDomain === canonicalHost.trim().toLowerCase()) {
    return true;
  }
  if (!aliasesJson) return false;
  try {
    const aliases: unknown = JSON.parse(aliasesJson);
    return (
      Array.isArray(aliases) &&
      aliases.some(
        (a: unknown) =>
          typeof a === "string" && a.trim().toLowerCase() === normProjectDomain,
      )
    );
  } catch {
    return false;
  }
}

export const FleetRepository = {
  /**
   * Retrieves the currently approved fleet roster version for an organization (Sol PV-2).
   * Strictly read-only; never writes or mutates on query.
   * Normalizes timestamp ordering across ISO and space formats (Sol F05).
   */
  async getApprovedRoster(
    organizationId: string,
    nowMs = Date.now(),
  ): Promise<RawFleetVersion | null> {
    const versions = await db
      .select()
      .from(fleetRosterVersions)
      .where(eq(fleetRosterVersions.organizationId, organizationId));

    if (versions.length === 0) return null;

    // Filter effective approvals to valid UTC times at or before the dashboard clock (Sol F08)
    const validVersions = versions.filter((v) => {
      const t = parseUtcTimestampMs(v.approvedAt);
      return Number.isFinite(t) && t <= nowMs;
    });

    if (validVersions.length === 0) return null;

    const sorted = sort(validVersions, (a, b) => {
      const tA = parseUtcTimestampMs(a.approvedAt);
      const tB = parseUtcTimestampMs(b.approvedAt);
      const diff = (isNaN(tB) ? 0 : tB) - (isNaN(tA) ? 0 : tA);
      if (diff !== 0) return diff;
      return b.id === a.id ? 0 : b.id > a.id ? 1 : -1;
    });

    return sorted[0] ?? null;
  },

  /**
   * Reads raw fleet entities in a fixed number of queries (strictly bounded, 2-4 queries total),
   * strictly read-only with no automatic mutation on read (Sol PV-2, F09).
   */
  async getRawFleetData(
    organizationId: string,
    nowMs = Date.now(),
  ): Promise<RawFleetData> {
    const version = await this.getApprovedRoster(organizationId, nowMs);

    if (!version) {
      throw new AppError("NOT_FOUND", "Fleet roster approval pending");
    }

    // Query 2: All members joined with active projects in 1 consolidated query (Sol F01, F09)
    const memberRows = await db
      .select({
        member: fleetRosterMembers,
        liveProjectId: projects.id,
        liveProjectDomain: projects.domain,
      })
      .from(fleetRosterMembers)
      .leftJoin(
        projects,
        and(
          eq(projects.id, fleetRosterMembers.projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.archivedAt),
        ),
      )
      .where(eq(fleetRosterMembers.versionId, version.id))
      .orderBy(fleetRosterMembers.canonicalHost);

    const validatedMembers = memberRows.map(
      ({ member, liveProjectId, liveProjectDomain }) => {
        const effectiveProjectId =
          liveProjectId &&
          isProjectDomainMatch(
            liveProjectDomain,
            member.canonicalHost,
            member.aliasesJson,
          )
            ? liveProjectId
            : null;
        return {
          ...member,
          projectId: effectiveProjectId,
        };
      },
    );

    // Query 3: Run items & Snapshots using injected clock, strict UTC parsing, binary tie-breaking, and full CTE pushdown (V4-03, V4-04, V4-06)
    const isPg = getDatabaseProvider() === "postgres";
    const nowIso = new Date(nowMs).toISOString();

    const friCompletedExpr = isPg
      ? sql.raw(pgSafeTs("fri.completed_at"))
      : sql.raw(sqliteSafeTs("fri.completed_at"));
    const fsObservedExpr = isPg
      ? sql.raw(pgSafeTs("fs.observed_at"))
      : sql.raw(sqliteSafeTs("fs.observed_at"));

    const friOrder = isPg
      ? sql`ORDER BY ${friCompletedExpr} DESC NULLS LAST, fri.id COLLATE "C" DESC`
      : sql`ORDER BY ${friCompletedExpr} DESC NULLS LAST, fri.id COLLATE BINARY DESC`;

    const fsOrder = isPg
      ? sql`ORDER BY ${fsObservedExpr} DESC NULLS LAST, fs.id COLLATE "C" DESC`
      : sql`ORDER BY ${fsObservedExpr} DESC NULLS LAST, fs.id COLLATE BINARY DESC`;

    const friValidClock = isPg
      ? sql`(${friCompletedExpr} IS NOT NULL AND ${friCompletedExpr} <= ${nowIso}::timestamptz)`
      : sql`(${friCompletedExpr} IS NOT NULL AND ${friCompletedExpr} <= julianday(${nowIso}))`;

    const fsValidClock = isPg
      ? sql`(${fsObservedExpr} IS NOT NULL AND ${fsObservedExpr} <= ${nowIso}::timestamptz AND ${friCompletedExpr} IS NOT NULL AND ${friCompletedExpr} <= ${nowIso}::timestamptz AND ${fsObservedExpr} <= ${friCompletedExpr})`
      : sql`(${fsObservedExpr} IS NOT NULL AND ${fsObservedExpr} <= julianday(${nowIso}) AND ${friCompletedExpr} IS NOT NULL AND ${friCompletedExpr} <= julianday(${nowIso}) AND ${fsObservedExpr} <= ${friCompletedExpr})`;

    const runItems = await db
      .select({
        id: fleetRunItems.id,
        runId: fleetRunItems.runId,
        memberId: fleetRunItems.memberId,
        projectId: fleetRunItems.projectId,
        auditId: fleetRunItems.auditId,
        primarySeriesKey: fleetRunItems.primarySeriesKey,
        status: fleetRunItems.status,
        attemptCount: fleetRunItems.attemptCount,
        errorCode: fleetRunItems.errorCode,
        startedAt: fleetRunItems.startedAt,
        completedAt: fleetRunItems.completedAt,
        rubricVersion: fleetRuns.rubricVersion,
      })
      .from(fleetRunItems)
      .innerJoin(
        fleetRuns,
        and(
          eq(fleetRunItems.runId, fleetRuns.id),
          eq(fleetRuns.organizationId, organizationId),
          eq(fleetRuns.rosterVersionId, version.id),
        ),
      )
      .where(
        sql`${fleetRunItems.id} IN (
          SELECT r.id FROM (
            SELECT fri.id,
                   ROW_NUMBER() OVER (
                     PARTITION BY fri.member_id, fri.status, fri.primary_series_key
                     ${friOrder}
                   ) as rn
            FROM fleet_run_items fri
            JOIN fleet_runs fr ON fr.id = fri.run_id
            JOIN fleet_roster_members rm ON rm.id = fri.member_id AND rm.version_id = fr.roster_version_id
            WHERE fr.organization_id = ${organizationId}
              AND fr.roster_version_id = ${version.id}
              AND rm.enrollment_state = 'active'
              AND fri.project_id = rm.project_id
              AND fri.status IN ('completed', 'partial', 'failed')
              AND ${friValidClock}
          ) r
          WHERE r.rn <= 30
        )`,
      )
      .orderBy(desc(fleetRunItems.completedAt), desc(fleetRunItems.id));

    // Query 4: Snapshots for this approved roster version bounded by series-aware window function (Sol Round 24 P2-07, R24-12, V4-06)
    const rawSnapshots = await db
      .select({
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
      })
      .from(fleetSnapshots)
      .innerJoin(fleetRunItems, eq(fleetSnapshots.runItemId, fleetRunItems.id))
      .innerJoin(
        fleetRuns,
        and(
          eq(fleetRunItems.runId, fleetRuns.id),
          eq(fleetRuns.organizationId, organizationId),
          eq(fleetRuns.rosterVersionId, version.id),
        ),
      )
      .where(
        sql`${fleetSnapshots.id} IN (
          SELECT s.id FROM (
            SELECT fs.id,
                   ROW_NUMBER() OVER (
                     PARTITION BY fs.member_id,
                                  fs.series_key,
                                  CASE WHEN fs.coverage = 100 AND fs.score_technical IS NOT NULL THEN 1 ELSE 0 END
                     ${fsOrder}
                   ) as rn
            FROM fleet_snapshots fs
            JOIN fleet_run_items fri ON fri.id = fs.run_item_id
            JOIN fleet_runs fr ON fr.id = fri.run_id
            JOIN fleet_roster_members rm ON rm.id = fs.member_id AND rm.version_id = fr.roster_version_id
            WHERE fr.organization_id = ${organizationId}
              AND fr.roster_version_id = ${version.id}
              AND fs.member_id = fri.member_id
              AND fs.project_id = fri.project_id
              AND fs.project_id = rm.project_id
              AND fs.series_key = fri.primary_series_key
              AND rm.enrollment_state = 'active'
              AND lower(trim(fs.canonical_host)) = lower(trim(rm.canonical_host))
              AND fri.status IN ('completed', 'partial', 'failed')
              AND ${fsValidClock}
          ) s
          WHERE s.rn <= 30
        )`,
      )
      .orderBy(desc(fleetSnapshots.observedAt), desc(fleetSnapshots.id));

    const snapshots: RawFleetSnapshotWithAttempt[] = [];
    for (const snap of rawSnapshots) {
      // P1-3 Relational Lineage & Tenant Isolation:
      // Exclude snapshots whose member/project lineage disagrees with parent run item
      if (
        snap.memberId !== snap.runItemMemberId ||
        snap.projectId !== snap.runItemProjectId
      ) {
        continue;
      }
      snapshots.push({
        ...snap,
        attemptStatus: snap.attemptStatus ?? null,
        errorCode: snap.errorCode ?? null,
        comparabilityKey: snap.comparabilityKey ?? null,
        seriesKey: snap.seriesKey ?? null,
        rubricVersion: snap.rubricVersion ?? null,
      });
    }

    return {
      version,
      members: validatedMembers,
      snapshots,
      runItems,
    };
  },
};
