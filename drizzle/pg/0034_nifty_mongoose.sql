CREATE TABLE "fleet_change_events" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"repo_name" text NOT NULL,
	"deployed_revision_id" text,
	"change_summary" text NOT NULL,
	"touched_paths_json" text DEFAULT '[]' NOT NULL,
	"live_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_change_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"change_event_id" text NOT NULL,
	"before_snapshot_id" text NOT NULL,
	"after_snapshot_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"attribution_status" text NOT NULL,
	"score_delta" integer NOT NULL,
	"verified_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_issue_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"member_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"affected_url" text NOT NULL,
	"template_signature" text,
	"expected_behavior" text NOT NULL,
	"observed_behavior" text NOT NULL,
	"suggested_skill" text,
	"status" text DEFAULT 'open' NOT NULL,
	"first_observed_at" text NOT NULL,
	"last_observed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_remediation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"issue_fingerprint" text NOT NULL,
	"skill_name" text NOT NULL,
	"skill_version" text DEFAULT '1.0.0' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"job_packet_json" text NOT NULL,
	"pr_url" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_roster_members" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"canonical_host" text NOT NULL,
	"project_id" text,
	"category" text NOT NULL,
	"category_emoji" text DEFAULT '🧱' NOT NULL,
	"tier" text DEFAULT 'Tier 1' NOT NULL,
	"site_intent" text DEFAULT 'commercial' NOT NULL,
	"platform" text DEFAULT 'wordpress_static' NOT NULL,
	"repo_name" text,
	"enrollment_state" text DEFAULT 'active' NOT NULL,
	"aliases_json" text DEFAULT '[]' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_roster_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"version_tag" text NOT NULL,
	"domain_count" integer DEFAULT 87 NOT NULL,
	"manifest_hash" text NOT NULL,
	"approved_by" text NOT NULL,
	"notes" text,
	"approved_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_rule_results" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"pillar" text NOT NULL,
	"rule_id" text NOT NULL,
	"status" text NOT NULL,
	"weight" double precision NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"applicable_units" integer DEFAULT 0 NOT NULL,
	"passed_units" integer DEFAULT 0 NOT NULL,
	"failed_units" integer DEFAULT 0 NOT NULL,
	"details_json" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_run_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"member_id" text NOT NULL,
	"project_id" text,
	"audit_id" text,
	"primary_series_key" text DEFAULT 'weekly-baseline' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_expires_at" text,
	"error_code" text,
	"error_detail" text,
	"started_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "fleet_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"roster_version_id" text NOT NULL,
	"rubric_version" text DEFAULT 'v1' NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"requester_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_domains" integer DEFAULT 87 NOT NULL,
	"completed_domains" integer DEFAULT 0 NOT NULL,
	"failed_domains" integer DEFAULT 0 NOT NULL,
	"median_score" double precision,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "fleet_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_item_id" text NOT NULL,
	"member_id" text NOT NULL,
	"project_id" text,
	"canonical_host" text NOT NULL,
	"score" double precision NOT NULL,
	"grade" text DEFAULT 'ungraded' NOT NULL,
	"coverage" double precision DEFAULT 100 NOT NULL,
	"is_provisional" boolean DEFAULT false NOT NULL,
	"provisional_lower" integer,
	"provisional_upper" integer,
	"has_incident_cap" boolean DEFAULT false NOT NULL,
	"incident_reason" text,
	"score_technical" double precision,
	"score_internal_links" double precision,
	"score_mobile_perf" double precision,
	"score_on_page" double precision,
	"score_schema" double precision,
	"score_ai_readiness" double precision,
	"series_key" text DEFAULT 'weekly-baseline' NOT NULL,
	"comparability_key" text,
	"evidence_manifest_r2_key" text,
	"evidence_manifest_hash" text,
	"observed_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_change_events" ADD CONSTRAINT "fleet_change_events_member_id_fleet_roster_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."fleet_roster_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_change_verifications" ADD CONSTRAINT "fleet_change_verifications_change_event_id_fleet_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."fleet_change_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_change_verifications" ADD CONSTRAINT "fleet_change_verifications_before_snapshot_id_fleet_snapshots_id_fk" FOREIGN KEY ("before_snapshot_id") REFERENCES "public"."fleet_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_change_verifications" ADD CONSTRAINT "fleet_change_verifications_after_snapshot_id_fleet_snapshots_id_fk" FOREIGN KEY ("after_snapshot_id") REFERENCES "public"."fleet_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_issue_occurrences" ADD CONSTRAINT "fleet_issue_occurrences_snapshot_id_fleet_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."fleet_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_issue_occurrences" ADD CONSTRAINT "fleet_issue_occurrences_member_id_fleet_roster_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."fleet_roster_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_remediation_jobs" ADD CONSTRAINT "fleet_remediation_jobs_member_id_fleet_roster_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."fleet_roster_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_roster_members" ADD CONSTRAINT "fleet_roster_members_version_id_fleet_roster_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."fleet_roster_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_roster_members" ADD CONSTRAINT "fleet_roster_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_roster_versions" ADD CONSTRAINT "fleet_roster_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_rule_results" ADD CONSTRAINT "fleet_rule_results_snapshot_id_fleet_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."fleet_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_run_items" ADD CONSTRAINT "fleet_run_items_run_id_fleet_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fleet_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_run_items" ADD CONSTRAINT "fleet_run_items_member_id_fleet_roster_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."fleet_roster_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_run_items" ADD CONSTRAINT "fleet_run_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_run_items" ADD CONSTRAINT "fleet_run_items_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_runs" ADD CONSTRAINT "fleet_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_runs" ADD CONSTRAINT "fleet_runs_roster_version_id_fleet_roster_versions_id_fk" FOREIGN KEY ("roster_version_id") REFERENCES "public"."fleet_roster_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_snapshots" ADD CONSTRAINT "fleet_snapshots_run_item_id_fleet_run_items_id_fk" FOREIGN KEY ("run_item_id") REFERENCES "public"."fleet_run_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_snapshots" ADD CONSTRAINT "fleet_snapshots_member_id_fleet_roster_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."fleet_roster_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_snapshots" ADD CONSTRAINT "fleet_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fleet_change_events_member_live_idx" ON "fleet_change_events" USING btree ("member_id","live_at");--> statement-breakpoint
CREATE INDEX "fleet_change_verifications_event_idx" ON "fleet_change_verifications" USING btree ("change_event_id");--> statement-breakpoint
CREATE INDEX "fleet_issue_occurrences_member_status_idx" ON "fleet_issue_occurrences" USING btree ("member_id","status");--> statement-breakpoint
CREATE INDEX "fleet_issue_occurrences_fingerprint_idx" ON "fleet_issue_occurrences" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "fleet_remediation_jobs_member_status_idx" ON "fleet_remediation_jobs" USING btree ("member_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_roster_members_version_host_idx" ON "fleet_roster_members" USING btree ("version_id","canonical_host");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_roster_members_version_project_idx" ON "fleet_roster_members" USING btree ("version_id","project_id");--> statement-breakpoint
CREATE INDEX "fleet_roster_members_project_id_idx" ON "fleet_roster_members" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_roster_versions_org_tag_idx" ON "fleet_roster_versions" USING btree ("organization_id","version_tag");--> statement-breakpoint
CREATE INDEX "fleet_rule_results_snapshot_pillar_idx" ON "fleet_rule_results" USING btree ("snapshot_id","pillar");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_run_items_run_member_idx" ON "fleet_run_items" USING btree ("run_id","member_id");--> statement-breakpoint
CREATE INDEX "fleet_run_items_audit_id_idx" ON "fleet_run_items" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "fleet_runs_org_started_idx" ON "fleet_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_snapshots_item_series_idx" ON "fleet_snapshots" USING btree ("run_item_id","series_key");--> statement-breakpoint
CREATE INDEX "fleet_snapshots_member_observed_idx" ON "fleet_snapshots" USING btree ("member_id","observed_at");--> statement-breakpoint
CREATE INDEX "fleet_snapshots_host_idx" ON "fleet_snapshots" USING btree ("canonical_host");