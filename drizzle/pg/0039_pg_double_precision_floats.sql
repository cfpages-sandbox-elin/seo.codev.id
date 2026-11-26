ALTER TABLE "keyword_metrics" ALTER COLUMN "cpc" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "keyword_metrics" ALTER COLUMN "competition" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "rank_tracking_keywords" ALTER COLUMN "cpc" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ALTER COLUMN "lcp_ms" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ALTER COLUMN "cls" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ALTER COLUMN "inp_ms" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "audit_lighthouse_results" ALTER COLUMN "ttfb_ms" SET DATA TYPE double precision;