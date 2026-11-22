import { and, desc, eq, isNull } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
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

interface RawFleetData {
  version: RawFleetVersion;
  members: RawFleetMember[];
  snapshots: RawFleetSnapshotWithAttempt[];
  runItems: RawFleetRunItem[];
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
      return b.id.localeCompare(a.id);
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
        let effectiveProjectId = liveProjectId ?? null;
        if (effectiveProjectId && liveProjectDomain) {
          const normProjectDomain = liveProjectDomain
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "");
          const normMemberHost = member.canonicalHost.trim().toLowerCase();
          let matches = normProjectDomain === normMemberHost;
          if (!matches && member.aliasesJson) {
            try {
              const aliases: unknown = JSON.parse(member.aliasesJson);
              if (Array.isArray(aliases)) {
                matches = aliases.some(
                  (a: unknown) =>
                    typeof a === "string" &&
                    a.trim().toLowerCase() === normProjectDomain,
                );
              }
            } catch {
              // ignore malformed aliases
            }
          }
          if (!matches) {
            effectiveProjectId = null;
          }
        }
        return {
          ...member,
          projectId: effectiveProjectId,
        };
      },
    );

    // Query 3: Run items for this approved roster version joined with runs (Sol F07, F08, F09)
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
      .orderBy(desc(fleetRunItems.completedAt), desc(fleetRunItems.id));

    // Query 4: Snapshots for this approved roster version joined with run items and runs (Sol F08, F09)
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
