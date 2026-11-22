import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
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
} from "./fleet.enums";

export const ruleResultStatuses = [
  "pass",
  "fail",
  "unknown",
  "not_applicable",
] as const;

// ============================================================================
// Fleet Aggregation & Timeline Tables (PRD: OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md)
// ============================================================================

// 1. Roster Versions: Audited snapshots of the 87-domain portfolio manifest
export const fleetRosterVersions = sqliteTable(
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
    approvedAt: text("approved_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("fleet_roster_versions_org_tag_idx").on(
      table.organizationId,
      table.versionTag,
    ),
  ],
);

// 2. Roster Members: Enrolled properties in the roster
export const fleetRosterMembers = sqliteTable(
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

// 3. Fleet Runs: Scheduled or manual fleet-wide audit batches
export const fleetRuns = sqliteTable(
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
    medianScore: real("median_score"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
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

// 4. Fleet Run Items: Individual domain execution lease and status
export const fleetRunItems = sqliteTable(
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
    leaseExpiresAt: text("lease_expires_at"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("fleet_run_items_run_member_idx").on(
      table.runId,
      table.memberId,
    ),
    index("fleet_run_items_audit_id_idx").on(table.auditId),
  ],
);

// 5. Fleet Snapshots: Immutable point-in-time score and grading
export const fleetSnapshots = sqliteTable(
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
    score: real("score").notNull(),
    grade: text("grade", { enum: fleetGrades }).notNull().default("ungraded"),
    coverage: real("coverage").notNull().default(100),
    isProvisional: integer("is_provisional", { mode: "boolean" })
      .notNull()
      .default(false),
    provisionalLower: integer("provisional_lower"),
    provisionalUpper: integer("provisional_upper"),
    hasIncidentCap: integer("has_incident_cap", { mode: "boolean" })
      .notNull()
      .default(false),
    incidentReason: text("incident_reason"),
    // 6-Pillar Sub-Scores (PRD Rubric v1)
    scoreTechnical: real("score_technical"),
    scoreInternalLinks: real("score_internal_links"),
    scoreMobilePerf: real("score_mobile_perf"),
    scoreOnPage: real("score_on_page"),
    scoreSchema: real("score_schema"),
    scoreAiReadiness: real("score_ai_readiness"),
    // Persisted Series & Comparability Identity (Sol F02, F08)
    seriesKey: text("series_key").notNull().default("weekly-baseline"),
    comparabilityKey: text("comparability_key"),
    // Evidence
    evidenceManifestR2Key: text("evidence_manifest_r2_key"),
    evidenceManifestHash: text("evidence_manifest_hash"),
    observedAt: text("observed_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

// 6. Fleet Rule Results: Granular pass/fail checks per snapshot
export const fleetRuleResults = sqliteTable(
  "fleet_rule_results",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => fleetSnapshots.id, { onDelete: "cascade" }),
    pillar: text("pillar", { enum: fleetPillars }).notNull(),
    ruleId: text("rule_id").notNull(),
    status: text("status", { enum: ruleResultStatuses }).notNull(),
    weight: real("weight").notNull(),
    score: real("score").notNull().default(0),
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

// 7. Fleet Issue Occurrences: Fingerprinted issues for triage and grouping
export const fleetIssueOccurrences = sqliteTable(
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
    firstObservedAt: text("first_observed_at").notNull(),
    lastObservedAt: text("last_observed_at").notNull(),
  },
  (table) => [
    index("fleet_issue_occurrences_member_status_idx").on(
      table.memberId,
      table.status,
    ),
    index("fleet_issue_occurrences_fingerprint_idx").on(table.fingerprint),
  ],
);

// 8. Fleet Change Events: Production deployments and commits
export const fleetChangeEvents = sqliteTable(
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
    liveAt: text("live_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("fleet_change_events_member_live_idx").on(
      table.memberId,
      table.liveAt,
    ),
  ],
);

// 9. Fleet Change Verifications: Causal attribution between commits and score delta
export const fleetChangeVerifications = sqliteTable(
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
    verifiedAt: text("verified_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("fleet_change_verifications_event_idx").on(table.changeEventId),
  ],
);

// 10. Fleet Remediation Jobs: Remediation packets bound to sovereign skills
export const fleetRemediationJobs = sqliteTable(
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("fleet_remediation_jobs_member_status_idx").on(
      table.memberId,
      table.status,
    ),
  ],
);
