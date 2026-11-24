ALTER TABLE "fleet_roster_members" ADD COLUMN IF NOT EXISTS "publish_root" text DEFAULT '.' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fleet_runs_org_roster_idx" ON "fleet_runs" USING btree ("organization_id","roster_version_id");
