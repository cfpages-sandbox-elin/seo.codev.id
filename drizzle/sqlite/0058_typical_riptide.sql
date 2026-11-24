ALTER TABLE `fleet_roster_members` ADD `publish_root` text DEFAULT '.' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `fleet_runs_org_roster_idx` ON `fleet_runs` (`organization_id`,`roster_version_id`);
