// Canonical shared enum definitions for dual-dialect Fleet tables.
// Used identically by SQLite (D1) and PostgreSQL schema declarations.

export const fleetTiers = ["Tier 1", "Tier 2", "Tier 3"] as const;
export type FleetTier = (typeof fleetTiers)[number];

export const fleetSiteIntents = [
  "commercial",
  "lead_gen",
  "brand",
  "utility",
] as const;
export type FleetSiteIntent = (typeof fleetSiteIntents)[number];

export const fleetPlatforms = [
  "wordpress_static",
  "astro",
  "react_spa",
  "custom",
] as const;
export type FleetPlatform = (typeof fleetPlatforms)[number];

export const fleetEnrollmentStates = [
  "active",
  "exempt",
  "parked",
  "excluded",
] as const;
export type FleetEnrollmentState = (typeof fleetEnrollmentStates)[number];

export const fleetGrades = ["A", "B", "C", "D", "F", "ungraded"] as const;
export type FleetGrade = (typeof fleetGrades)[number];

export const fleetRunTriggers = ["scheduled", "manual", "post_deploy"] as const;
export type FleetRunTrigger = (typeof fleetRunTriggers)[number];

export const fleetRunStatuses = [
  "queued",
  "running",
  "completed",
  "partial",
  "cancelled",
  "budget_paused",
] as const;
export type FleetRunStatus = (typeof fleetRunStatuses)[number];

export const fleetRunItemStatuses = [
  "queued",
  "dispatching",
  "crawling",
  "evidence_pending",
  "publishing",
  "completed",
  "partial",
  "failed",
  "skipped",
] as const;
export type FleetRunItemStatus = (typeof fleetRunItemStatuses)[number];

export const fleetPillars = [
  "technical",
  "internal_links",
  "mobile_perf",
  "on_page",
  "schema",
  "ai_readiness",
] as const;
export type FleetPillar = (typeof fleetPillars)[number];

export const fleetRuleSeverities = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type FleetRuleSeverity = (typeof fleetRuleSeverities)[number];

export const fleetIssueStatuses = [
  "open",
  "acknowledged",
  "in_remediation",
  "resolved",
  "regressed",
] as const;
export type FleetIssueStatus = (typeof fleetIssueStatuses)[number];

export const fleetChangeSources = [
  "audit_detected",
  "git_commit",
  "dns_record",
  "manual_entry",
] as const;
export type FleetChangeSource = (typeof fleetChangeSources)[number];

export const fleetVerificationOutcomes = [
  "pending",
  "verified_improved",
  "verified_regressed",
  "inconclusive",
  "expired",
] as const;
export type FleetVerificationOutcome =
  (typeof fleetVerificationOutcomes)[number];

export const fleetRemediationTypes = [
  "internal_links_insert",
  "meta_description_repair",
  "schema_jsonld_fix",
  "canonical_repair",
  "custom",
] as const;
export type FleetRemediationType = (typeof fleetRemediationTypes)[number];

export const fleetRemediationJobStatuses = [
  "draft",
  "pr_created",
  "pr_merged",
  "applied_direct",
  "failed",
  "aborted",
] as const;
export type FleetRemediationJobStatus =
  (typeof fleetRemediationJobStatuses)[number];
