import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";
import { audits } from "./audit.schema";
import {
  fleetTiers,
  fleetSiteIntents,
  fleetPlatforms,
  fleetEnrollmentStates,
  fleetGrades,
  fleetRunTriggers,
  fleetRunStatuses,
  fleetRunItemStatuses,
  fleetPillars,
  fleetRuleSeverities,
  fleetIssueStatuses,
  fleetVerificationOutcomes,
  fleetRemediationJobStatuses,
} from "../fleet.enums";
import { ruleResultStatuses } from "../fleet.schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

// ============================================================================
// Fleet Aggregation & Timeline Tables (PostgreSQL Dual-Dialect Parity)
// ============================================================================

// 1. Roster Versions
export const fleetRosterVersions = pgTable(
  "fleet_roster_versions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    versionTag: text("version_tag").notNull(),
    domainCount: integer("domain_count").notNull().default(87),
    manifestHash: text("manifest_hash").notNull(),
    approvedBy: text("approved_by").notNull(),
    notes: text("notes"),
    approvedAt: timestampColumn("approved_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("fleet_roster_versions_org_tag_idx").on(
      table.organizationId,
      table.versionTag,
    ),
  ],
);

// 2. Roster Members
export const fleetRosterMembers = pgTable(
  "fleet_roster_members",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => fleetRosterVersions.id, { onDelete: "cascade" }),
    canonicalHost: text("canonical_host").notNull(),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    category: text("category").notNull(),
    categoryEmoji: text("category_emoji").notNull().default("🧱"),
    tier: text("tier", { enum: fleetTiers }).notNull().default("Tier 1"),
    siteIntent: text("site_intent", { enum: fleetSiteIntents })
      .notNull()
      .default("commercial"),
    platform: text("platform", { enum: fleetPlatforms })
      .notNull()
      .default("wordpress_static"),
    repoName: text("repo_name"),
    enrollmentState: text("enrollment_state", { enum: fleetEnrollmentStates })
      .notNull()
      .default("active"),
    aliasesJson: text("aliases_json").notNull().default("[]"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("fleet_roster_members_version_host_idx").on(
      table.versionId,
      table.canonicalHost,
    ),
    uniqueIndex("fleet_roster_members_version_project_idx").on(
      table.versionId,
      table.projectId,
    ),
    index("fleet_roster_members_project_id_idx").on(table.projectId),
  ],
);

// 3. Fleet Runs
export const fleetRuns = pgTable(
  "fleet_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    rosterVersionId: text("roster_version_id")
      .notNull()
      .references(() => fleetRosterVersions.id, { onDelete: "cascade" }),
    rubricVersion: text("rubric_version").notNull().default("v1"),
    trigger: text("trigger", { enum: fleetRunTriggers })
      .notNull()
      .default("scheduled"),
    requesterId: text("requester_id").notNull(),
    status: text("status", { enum: fleetRunStatuses })
      .notNull()
      .default("queued"),
    totalDomains: integer("total_domains").notNull().default(87),
    completedDomains: integer("completed_domains").notNull().default(0),
    failedDomains: integer("failed_domains").notNull().default(0),
    medianScore: doublePrecision("median_score"),
    startedAt: timestampColumn("started_at").notNull().default(isoNow),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    index("fleet_runs_org_started_idx").on(
      table.organizationId,
      table.startedAt,
    ),
    index("fleet_runs_org_roster_idx").on(
      table.organizationId,
      table.rosterVersionId,
    ),
  ],
);

// 4. Fleet Run Items
export const fleetRunItems = pgTable(
  "fleet_run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => fleetRuns.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => fleetRosterMembers.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    auditId: text("audit_id").references(() => audits.id, {
      onDelete: "set null",
    }),
    primarySeriesKey: text("primary_series_key")
      .notNull()
      .default("weekly-baseline"),
    status: text("status", { enum: fleetRunItemStatuses })
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    startedAt: timestampColumn("started_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    uniqueIndex("fleet_run_items_run_member_idx").on(
      table.runId,
      table.memberId,
    ),
    index("fleet_run_items_audit_id_idx").on(table.auditId),
  ],
);

// 5. Fleet Snapshots
export const fleetSnapshots = pgTable(
  "fleet_snapshots",
  {
    id: text("id").primaryKey(),
    runItemId: text("run_item_id")
      .notNull()
      .references(() => fleetRunItems.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => fleetRosterMembers.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    canonicalHost: text("canonical_host").notNull(),
    score: doublePrecision("score").notNull(),
    grade: text("grade", { enum: fleetGrades }).notNull().default("ungraded"),
    coverage: doublePrecision("coverage").notNull().default(100),
    isProvisional: boolean("is_provisional").notNull().default(false),
    provisionalLower: integer("provisional_lower"),
    provisionalUpper: integer("provisional_upper"),
    hasIncidentCap: boolean("has_incident_cap").notNull().default(false),
    incidentReason: text("incident_reason"),
    // 6-Pillar Sub-Scores
    scoreTechnical: doublePrecision("score_technical"),
    scoreInternalLinks: doublePrecision("score_internal_links"),
    scoreMobilePerf: doublePrecision("score_mobile_perf"),
    scoreOnPage: doublePrecision("score_on_page"),
    scoreSchema: doublePrecision("score_schema"),
    scoreAiReadiness: doublePrecision("score_ai_readiness"),
    // Persisted Series & Comparability Identity (Sol F02, F08)
    seriesKey: text("series_key").notNull().default("weekly-baseline"),
    comparabilityKey: text("comparability_key"),
    // Evidence
    evidenceManifestR2Key: text("evidence_manifest_r2_key"),
    evidenceManifestHash: text("evidence_manifest_hash"),
    observedAt: timestampColumn("observed_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("fleet_snapshots_item_series_idx").on(
      table.runItemId,
      table.seriesKey,
    ),
    index("fleet_snapshots_member_observed_idx").on(
      table.memberId,
      table.observedAt,
    ),
    index("fleet_snapshots_host_idx").on(table.canonicalHost),
  ],
);

// 6. Fleet Rule Results
export const fleetRuleResults = pgTable(
  "fleet_rule_results",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => fleetSnapshots.id, { onDelete: "cascade" }),
    pillar: text("pillar", { enum: fleetPillars }).notNull(),
    ruleId: text("rule_id").notNull(),
    status: text("status", { enum: ruleResultStatuses }).notNull(),
    weight: doublePrecision("weight").notNull(),
    score: doublePrecision("score").notNull().default(0),
    applicableUnits: integer("applicable_units").notNull().default(0),
    passedUnits: integer("passed_units").notNull().default(0),
    failedUnits: integer("failed_units").notNull().default(0),
    detailsJson: text("details_json").notNull().default("{}"),
  },
  (table) => [
    index("fleet_rule_results_snapshot_pillar_idx").on(
      table.snapshotId,
      table.pillar,
    ),
  ],
);

// 7. Fleet Issue Occurrences
export const fleetIssueOccurrences = pgTable(
  "fleet_issue_occurrences",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => fleetSnapshots.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => fleetRosterMembers.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity", { enum: fleetRuleSeverities }).notNull(),
    affectedUrl: text("affected_url").notNull(),
    templateSignature: text("template_signature"),
    expectedBehavior: text("expected_behavior").notNull(),
    observedBehavior: text("observed_behavior").notNull(),
    suggestedSkill: text("suggested_skill"),
    status: text("status", { enum: fleetIssueStatuses })
      .notNull()
      .default("open"),
    firstObservedAt: timestampColumn("first_observed_at").notNull(),
    lastObservedAt: timestampColumn("last_observed_at").notNull(),
  },
  (table) => [
    index("fleet_issue_occurrences_member_status_idx").on(
      table.memberId,
      table.status,
    ),
    index("fleet_issue_occurrences_fingerprint_idx").on(table.fingerprint),
  ],
);

// 8. Fleet Change Events
export const fleetChangeEvents = pgTable(
  "fleet_change_events",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => fleetRosterMembers.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    repoName: text("repo_name").notNull(),
    deployedRevisionId: text("deployed_revision_id"),
    changeSummary: text("change_summary").notNull(),
    touchedPathsJson: text("touched_paths_json").notNull().default("[]"),
    liveAt: timestampColumn("live_at").notNull().default(isoNow),
  },
  (table) => [
    index("fleet_change_events_member_live_idx").on(
      table.memberId,
      table.liveAt,
    ),
  ],
);

// 9. Fleet Change Verifications
export const fleetChangeVerifications = pgTable(
  "fleet_change_verifications",
  {
    id: text("id").primaryKey(),
    changeEventId: text("change_event_id")
      .notNull()
      .references(() => fleetChangeEvents.id, { onDelete: "cascade" }),
    beforeSnapshotId: text("before_snapshot_id")
      .notNull()
      .references(() => fleetSnapshots.id, { onDelete: "cascade" }),
    afterSnapshotId: text("after_snapshot_id")
      .notNull()
      .references(() => fleetSnapshots.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    attributionStatus: text("attribution_status", {
      enum: fleetVerificationOutcomes,
    }).notNull(),
    scoreDelta: integer("score_delta").notNull(),
    verifiedAt: timestampColumn("verified_at").notNull().default(isoNow),
  },
  (table) => [
    index("fleet_change_verifications_event_idx").on(table.changeEventId),
  ],
);

// 10. Fleet Remediation Jobs
export const fleetRemediationJobs = pgTable(
  "fleet_remediation_jobs",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => fleetRosterMembers.id, { onDelete: "cascade" }),
    issueFingerprint: text("issue_fingerprint").notNull(),
    skillName: text("skill_name").notNull(),
    skillVersion: text("skill_version").notNull().default("1.0.0"),
    status: text("status", { enum: fleetRemediationJobStatuses })
      .notNull()
      .default("draft"),
    jobPacketJson: text("job_packet_json").notNull(),
    prUrl: text("pr_url"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("fleet_remediation_jobs_member_status_idx").on(
      table.memberId,
      table.status,
    ),
  ],
);
