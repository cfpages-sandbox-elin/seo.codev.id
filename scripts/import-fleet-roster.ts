/**
 * CLI runner for offline approved roster import and synchronization (Sol F01, F04, F05, F07, P1-4, P2-6).
 * Usage: pnpm exec tsx scripts/import-fleet-roster.ts <orgId> --approval <file>
 */
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { getPlatformProxy } from "wrangler";
import { drizzle } from "drizzle-orm/d1";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  fleetRosterMembers,
  fleetRosterVersions,
} from "../src/db/fleet.schema";
import { projects } from "../src/db/app.schema";
import {
  FLEET_MANIFEST_MEMBERS,
  FLEET_MANIFEST_VERSION,
} from "../src/server/features/fleet/data/fleetManifest";
import { parseUtcTimestampMs } from "../src/server/features/fleet/services/fleetConstants";
import { normalizeGitRelativePath } from "./github-archive-utils";

const USAGE =
  "Usage: pnpm exec tsx scripts/import-fleet-roster.ts <orgId> --approval <file>";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const approvalSchema = z.strictObject({
  organizationId: z.string().trim().min(1),
  versionTag: z.literal(FLEET_MANIFEST_VERSION),
  rosterPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBy: z.string().trim().min(1),
  approvedAt: z.string().trim().min(1).optional(),
});

export function hashCanonicalRosterPlan(
  organizationId: string,
  members: typeof FLEET_MANIFEST_MEMBERS,
): string {
  const seenHosts = new Map<
    string,
    { repoName: string | null; publishRoot: string }
  >();
  for (const m of members) {
    const host = m.canonicalHost.toLowerCase().trim();
    const normRoot = normalizeGitRelativePath(m.publishRoot);
    const prev = seenHosts.get(host);
    if (
      prev &&
      (prev.repoName !== (m.repoName ?? null) || prev.publishRoot !== normRoot)
    ) {
      throw new Error(
        `CONFLICT: Conflicting approved mappings for host '${host}': '${prev.repoName}' (${prev.publishRoot}) vs '${m.repoName}' (${normRoot})`,
      );
    }
    seenHosts.set(host, {
      repoName: m.repoName ?? null,
      publishRoot: normRoot,
    });
  }

  const payload = {
    organizationId,
    versionTag: FLEET_MANIFEST_VERSION,
    members: members.map((m) => ({
      canonicalHost: m.canonicalHost.toLowerCase().trim(),
      category: m.category,
      categoryEmoji: m.categoryEmoji,
      tier: m.tier,
      siteIntent: m.siteIntent,
      platform: m.platform,
      repoName: m.repoName ?? null,
      publishRoot: normalizeGitRelativePath(m.publishRoot),
      enrollmentState: "active",
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function formatImporterError(error: unknown): string {
  if (error instanceof CliUsageError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

export async function importApprovedRoster(
  organizationId: string,
  approval: z.infer<typeof approvalSchema>,
): Promise<string> {
  if (approval.organizationId !== organizationId) {
    throw new CliUsageError("Approval does not match the target organization");
  }

  const versionId = `roster-${organizationId}-${FLEET_MANIFEST_VERSION}`;
  const manifestHash = hashCanonicalRosterPlan(
    organizationId,
    FLEET_MANIFEST_MEMBERS,
  );

  if (approval.rosterPlanSha256 !== manifestHash) {
    throw new CliUsageError("Approval does not match the target roster plan");
  }

  const approvedBy = approval.approvedBy;
  const approvedAt = approval.approvedAt ?? new Date().toISOString();
  const approvedAtMs = parseUtcTimestampMs(approvedAt);
  if (!Number.isFinite(approvedAtMs)) {
    throw new CliUsageError("Invalid roster approval time");
  }

  const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>({
    remoteBindings: false,
  });

  try {
    const db = drizzle(env.DB);
    const existing = await db
      .select()
      .from(fleetRosterVersions)
      .where(
        and(
          eq(fleetRosterVersions.organizationId, organizationId),
          eq(fleetRosterVersions.versionTag, FLEET_MANIFEST_VERSION),
        ),
      );

    if (existing[0]) {
      if (existing[0].manifestHash !== manifestHash) {
        throw new Error(
          `CONFLICT: Roster version hash mismatch for ${FLEET_MANIFEST_VERSION}`,
        );
      }
      const [memberCountRow] = await db
        .select({ memberCount: count() })
        .from(fleetRosterMembers)
        .where(eq(fleetRosterMembers.versionId, existing[0].id));
      const persistedMembers = Number(memberCountRow?.memberCount ?? 0);
      if (
        existing[0].domainCount !== FLEET_MANIFEST_MEMBERS.length ||
        persistedMembers !== FLEET_MANIFEST_MEMBERS.length
      ) {
        throw new Error(
          `INCOMPLETE_ROSTER_VERSION: Existing roster version '${existing[0].id}' has ${persistedMembers} persisted member(s) and declared domainCount=${existing[0].domainCount} (expected ${FLEET_MANIFEST_MEMBERS.length}).`,
        );
      }
      return existing[0].id;
    }

    const orgProjects = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(projects.createdAt, projects.id);

    const domainToProjectMap = new Map<string, string>();
    const ambiguousHosts = new Set<string>();
    const legacyNonCanonicalProjects: Array<{
      id: string;
      rawDomain: string;
      strippedHost: string;
    }> = [];
    for (const p of orgProjects) {
      if (p.domain) {
        const canonical = p.domain.trim().toLowerCase();
        const stripped = canonical
          .replace(/^https?:\/\//, "")
          .replace(/\/+$/, "");
        if (canonical !== stripped) {
          legacyNonCanonicalProjects.push({
            id: p.id,
            rawDomain: p.domain,
            strippedHost: stripped,
          });
          continue;
        }
        if (
          domainToProjectMap.has(canonical) &&
          domainToProjectMap.get(canonical) !== p.id
        ) {
          ambiguousHosts.add(canonical);
        } else {
          domainToProjectMap.set(canonical, p.id);
        }
      }
    }

    const rosterLegacyMatches = legacyNonCanonicalProjects.filter(
      (legacy) =>
        FLEET_MANIFEST_MEMBERS.some(
          (m) => m.canonicalHost.trim().toLowerCase() === legacy.strippedHost,
        ) && !domainToProjectMap.has(legacy.strippedHost),
    );
    if (rosterLegacyMatches.length > 0) {
      for (const leg of rosterLegacyMatches) {
        console.warn(
          `[WARN] Leaving manifest host '${leg.strippedHost}' unlinked: project '${leg.id}' stores non-canonical domain '${leg.rawDomain}' (expected canonical hostname without scheme/slash).`,
        );
      }
    }

    const rosterAmbiguous = FLEET_MANIFEST_MEMBERS.filter((m) =>
      ambiguousHosts.has(m.canonicalHost.trim().toLowerCase()),
    ).map((m) => m.canonicalHost);
    if (rosterAmbiguous.length > 0) {
      throw new Error(
        `AMBIGUOUS_PROJECT_BINDING: Multiple active projects found in organization '${organizationId}' for manifest host(s): ${rosterAmbiguous.join(", ")}.`,
      );
    }

    try {
      await db.batch([
        db.insert(fleetRosterVersions).values({
          id: versionId,
          organizationId,
          versionTag: FLEET_MANIFEST_VERSION,
          domainCount: FLEET_MANIFEST_MEMBERS.length,
          manifestHash,
          approvedBy,
          approvedAt,
          notes:
            "Canonical 87-domain portfolio manifest per PRD launch contract",
        }),
        ...FLEET_MANIFEST_MEMBERS.map((member) => {
          const memberId = `${versionId}-${member.canonicalHost.replace(/[^a-z0-9.-]/gi, "-")}`;
          const matchedProjectId =
            domainToProjectMap.get(member.canonicalHost.toLowerCase()) ?? null;

          return db.insert(fleetRosterMembers).values({
            id: memberId,
            versionId,
            canonicalHost: member.canonicalHost,
            projectId: matchedProjectId,
            category: member.category,
            categoryEmoji: member.categoryEmoji,
            tier: member.tier,
            siteIntent: member.siteIntent,
            platform: member.platform,
            repoName: member.repoName ?? null,
            publishRoot: normalizeGitRelativePath(member.publishRoot),
            enrollmentState: "active",
            aliasesJson: "[]",
          });
        }),
      ]);

      return versionId;
    } catch (batchErr: any) {
      // Sol Round 24 P2-06: Check if concurrent import committed the exact same approved roster
      const retryExisting = await db
        .select()
        .from(fleetRosterVersions)
        .where(
          and(
            eq(fleetRosterVersions.organizationId, organizationId),
            eq(fleetRosterVersions.versionTag, FLEET_MANIFEST_VERSION),
          ),
        );
      if (retryExisting[0]) {
        const [retryCountRow] = await db
          .select({ memberCount: count() })
          .from(fleetRosterMembers)
          .where(eq(fleetRosterMembers.versionId, retryExisting[0].id));
        const persistedRetryMembers = Number(retryCountRow?.memberCount ?? 0);
        if (
          retryExisting[0].manifestHash === manifestHash &&
          retryExisting[0].domainCount === FLEET_MANIFEST_MEMBERS.length &&
          persistedRetryMembers === FLEET_MANIFEST_MEMBERS.length
        ) {
          return retryExisting[0].id;
        }
        throw new Error(
          `CONFLICT: Roster version mismatch for ${FLEET_MANIFEST_VERSION} (hash '${retryExisting[0].manifestHash}' vs '${manifestHash}', members ${persistedRetryMembers}/${FLEET_MANIFEST_MEMBERS.length})`,
        );
      }
      throw batchErr;
    }
  } finally {
    await dispose();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        help: { type: "boolean", short: "h" },
        approval: { type: "string" },
      },
    });
  } catch (err) {
    throw new CliUsageError(
      `${err instanceof Error ? err.message : String(err)}\n${USAGE}`,
    );
  }

  if (parsed.values.help) {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  const tokens = parsed.tokens ?? [];
  const approvals = tokens.filter(
    (t) => t.kind === "option" && t.name === "approval",
  );
  if (parsed.positionals.length !== 1 || approvals.length !== 1) {
    throw new CliUsageError(USAGE);
  }

  const rawOrgId = parsed.positionals[0]!;
  const targetOrgId = rawOrgId.trim();
  if (!targetOrgId || targetOrgId !== rawOrgId) {
    throw new CliUsageError(
      "Invalid organization identifier: must not be empty or padded with whitespace",
    );
  }

  const approvalPath = parsed.values.approval as string;
  if (!existsSync(approvalPath)) {
    throw new CliUsageError(`Approval file does not exist: ${approvalPath}`);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(approvalPath, "utf8"));
  } catch {
    throw new CliUsageError(`Malformed approval file: ${approvalPath}`);
  }

  const result = approvalSchema.safeParse(rawJson);
  if (!result.success) {
    throw new CliUsageError(
      `Invalid approval schema: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
  }

  const approvalData = result.data;
  if (approvalData.organizationId !== targetOrgId) {
    throw new CliUsageError(
      `Organization mismatch: approval file specified ${approvalData.organizationId}, but CLI targeted ${targetOrgId}`,
    );
  }

  if (approvalData.rosterPlanSha256) {
    const expectedHash = hashCanonicalRosterPlan(
      targetOrgId,
      FLEET_MANIFEST_MEMBERS,
    );
    if (approvalData.rosterPlanSha256 !== expectedHash) {
      throw new CliUsageError("Approval does not match the target roster plan");
    }
  }

  try {
    const id = await importApprovedRoster(targetOrgId, approvalData);
    console.log(`Successfully approved and imported roster: ${id}`);
    process.exitCode = 0;
  } catch (err) {
    console.error(formatImporterError(err));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main().catch((error: unknown) => {
    console.error(formatImporterError(error));
    process.exitCode = 1;
  });
}
