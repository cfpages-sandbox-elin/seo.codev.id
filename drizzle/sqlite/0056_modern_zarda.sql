CREATE TABLE `fleet_change_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`commit_sha` text NOT NULL,
	`repo_name` text NOT NULL,
	`deployed_revision_id` text,
	`change_summary` text NOT NULL,
	`touched_paths_json` text DEFAULT '[]' NOT NULL,
	`live_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `fleet_roster_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fleet_change_events_member_live_idx` ON `fleet_change_events` (`member_id`,`live_at`);--> statement-breakpoint
CREATE TABLE `fleet_change_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`change_event_id` text NOT NULL,
	`before_snapshot_id` text NOT NULL,
	`after_snapshot_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`attribution_status` text NOT NULL,
	`score_delta` integer NOT NULL,
	`verified_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`change_event_id`) REFERENCES `fleet_change_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`before_snapshot_id`) REFERENCES `fleet_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`after_snapshot_id`) REFERENCES `fleet_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fleet_change_verifications_event_idx` ON `fleet_change_verifications` (`change_event_id`);--> statement-breakpoint
CREATE TABLE `fleet_issue_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`member_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`affected_url` text NOT NULL,
	`template_signature` text,
	`expected_behavior` text NOT NULL,
	`observed_behavior` text NOT NULL,
	`suggested_skill` text,
	`status` text DEFAULT 'open' NOT NULL,
	`first_observed_at` text NOT NULL,
	`last_observed_at` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `fleet_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `fleet_roster_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fleet_issue_occurrences_member_status_idx` ON `fleet_issue_occurrences` (`member_id`,`status`);--> statement-breakpoint
CREATE INDEX `fleet_issue_occurrences_fingerprint_idx` ON `fleet_issue_occurrences` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `fleet_remediation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`issue_fingerprint` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_version` text DEFAULT '1.0.0' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`job_packet_json` text NOT NULL,
	`pr_url` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `fleet_roster_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fleet_remediation_jobs_member_status_idx` ON `fleet_remediation_jobs` (`member_id`,`status`);--> statement-breakpoint
CREATE TABLE `fleet_roster_members` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`canonical_host` text NOT NULL,
	`project_id` text,
	`category` text NOT NULL,
	`category_emoji` text DEFAULT '🧱' NOT NULL,
	`tier` text DEFAULT 'Tier 1' NOT NULL,
	`site_intent` text DEFAULT 'commercial' NOT NULL,
	`platform` text DEFAULT 'wordpress_static' NOT NULL,
	`repo_name` text,
	`enrollment_state` text DEFAULT 'active' NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `fleet_roster_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_roster_members_version_host_idx` ON `fleet_roster_members` (`version_id`,`canonical_host`);--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_roster_members_version_project_idx` ON `fleet_roster_members` (`version_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `fleet_roster_members_project_id_idx` ON `fleet_roster_members` (`project_id`);--> statement-breakpoint
CREATE TABLE `fleet_roster_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`version_tag` text NOT NULL,
	`domain_count` integer DEFAULT 87 NOT NULL,
	`manifest_hash` text NOT NULL,
	`approved_by` text NOT NULL,
	`notes` text,
	`approved_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_roster_versions_org_tag_idx` ON `fleet_roster_versions` (`organization_id`,`version_tag`);--> statement-breakpoint
CREATE TABLE `fleet_rule_results` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`pillar` text NOT NULL,
	`rule_id` text NOT NULL,
	`status` text NOT NULL,
	`weight` real NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`applicable_units` integer DEFAULT 0 NOT NULL,
	`passed_units` integer DEFAULT 0 NOT NULL,
	`failed_units` integer DEFAULT 0 NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `fleet_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fleet_rule_results_snapshot_pillar_idx` ON `fleet_rule_results` (`snapshot_id`,`pillar`);--> statement-breakpoint
CREATE TABLE `fleet_run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`member_id` text NOT NULL,
	`project_id` text,
	`audit_id` text,
	`primary_series_key` text DEFAULT 'weekly-baseline' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`error_code` text,
	`error_detail` text,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `fleet_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `fleet_roster_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_run_items_run_member_idx` ON `fleet_run_items` (`run_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `fleet_run_items_audit_id_idx` ON `fleet_run_items` (`audit_id`);--> statement-breakpoint
CREATE TABLE `fleet_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`roster_version_id` text NOT NULL,
	`rubric_version` text DEFAULT 'v1' NOT NULL,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`requester_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total_domains` integer DEFAULT 87 NOT NULL,
	`completed_domains` integer DEFAULT 0 NOT NULL,
	`failed_domains` integer DEFAULT 0 NOT NULL,
	`median_score` real,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`roster_version_id`) REFERENCES `fleet_roster_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fleet_runs_org_started_idx` ON `fleet_runs` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `fleet_runs_org_roster_idx` ON `fleet_runs` (`organization_id`,`roster_version_id`);--> statement-breakpoint
CREATE TABLE `fleet_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`run_item_id` text NOT NULL,
	`member_id` text NOT NULL,
	`project_id` text,
	`canonical_host` text NOT NULL,
	`score` real NOT NULL,
	`grade` text DEFAULT 'ungraded' NOT NULL,
	`coverage` real DEFAULT 100 NOT NULL,
	`is_provisional` integer DEFAULT false NOT NULL,
	`provisional_lower` integer,
	`provisional_upper` integer,
	`has_incident_cap` integer DEFAULT false NOT NULL,
	`incident_reason` text,
	`score_technical` real,
	`score_internal_links` real,
	`score_mobile_perf` real,
	`score_on_page` real,
	`score_schema` real,
	`score_ai_readiness` real,
	`series_key` text DEFAULT 'weekly-baseline' NOT NULL,
	`comparability_key` text,
	`evidence_manifest_r2_key` text,
	`evidence_manifest_hash` text,
	`observed_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`run_item_id`) REFERENCES `fleet_run_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `fleet_roster_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_snapshots_item_series_idx` ON `fleet_snapshots` (`run_item_id`,`series_key`);--> statement-breakpoint
CREATE INDEX `fleet_snapshots_member_observed_idx` ON `fleet_snapshots` (`member_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `fleet_snapshots_host_idx` ON `fleet_snapshots` (`canonical_host`);