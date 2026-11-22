/**
 * Canonical 87-Domain Portfolio Manifest for OpenSEO Fleet View.
 *
 * Source: PORTFOLIO/PROJECTS_CATEGORIES.md, PROJECTS_GITHUB.md, and KNOWLEDGE-OPEN-SEO.md.
 * Frozen launch contract per OPERATIONS/PROJECTS/OPENSEO-AGGREGATED-FLEET-VIEW-PRD.md.
 */
import manifestData from "./fleetManifest.json";

interface FleetManifestMember {
  canonicalHost: string;
  category: string;
  categoryEmoji: string;
  tier: "Tier 1" | "Tier 2" | "Tier 3";
  siteIntent: "commercial" | "lead_gen" | "brand" | "utility";
  platform: "wordpress_static" | "astro" | "react_spa" | "custom";
  repoName?: string;
  clusterSlug?: string;
}

export const FLEET_MANIFEST_VERSION = "2026-11-22-v1";

export const FLEET_MANIFEST_MEMBERS: FleetManifestMember[] = manifestData.map(
  (m): FleetManifestMember => ({
    canonicalHost: m.canonicalHost,
    category: m.category,
    categoryEmoji: m.categoryEmoji,
    tier:
      m.tier === "Tier 1" || m.tier === "Tier 2" || m.tier === "Tier 3"
        ? m.tier
        : "Tier 3",
    siteIntent:
      m.siteIntent === "commercial" ||
      m.siteIntent === "lead_gen" ||
      m.siteIntent === "brand" ||
      m.siteIntent === "utility"
        ? m.siteIntent
        : "commercial",
    platform:
      m.platform === "wordpress_static" ||
      m.platform === "astro" ||
      m.platform === "react_spa"
        ? m.platform
        : "custom",
    repoName: m.repoName,
    clusterSlug: m.clusterSlug,
  }),
);
