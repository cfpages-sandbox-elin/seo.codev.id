/**
 * @file src/custom/serpCache.ts
 * @description Isolated custom extension module for OpenSEO.
 * Implements 24-hour R2 SERP caching and multi-tenant deduplication across sister domains.
 *
 * Keeping this logic in src/custom/ guarantees that git merges and rebases from
 * upstream (every-app/open-seo) will never produce conflicts on our custom code.
 */

import type { DataforseoApiCallCost } from "@/server/lib/dataforseo/envelope";
import type { SerpLiveItem } from "@/server/lib/dataforseo/serp";

export interface SerpCacheParams {
  keyword: string;
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
  device: "desktop" | "mobile";
  depth: number;
}

/** Standard zero-cost billing envelope for R2 cache hits */
export const CACHED_SERP_BILLING: DataforseoApiCallCost = {
  path: ["v3", "serp", "google", "organic", "live", "advanced"],
  costUsd: 0,
};

/** Default cache time: 24 hours (86,400 seconds) */
export const SERP_CACHE_TTL_SECONDS = 86_400;

/**
 * Computes a deterministic cache key for a SERP query.
 */
export async function buildSerpCacheKey(
  params: SerpCacheParams,
): Promise<string | null> {
  try {
    const { buildCacheKey } = await import("@/server/lib/r2-cache");
    return await buildCacheKey("serp:google-organic", {
      keyword: params.keyword.toLowerCase().trim(),
      locationCode: params.locationCode,
      languageCode: params.languageCode,
      locationName: params.locationName ?? null,
      device: params.device,
      depth: params.depth,
    });
  } catch {
    return null;
  }
}

/**
 * Retrieves cached SERP items from R2 if present and not expired.
 * Returns null if cache is missed or if R2 is unavailable.
 */
export async function getCachedSerp(
  params: SerpCacheParams,
): Promise<SerpLiveItem[] | null> {
  try {
    const cacheKey = await buildSerpCacheKey(params);
    if (!cacheKey) return null;

    const { getCached } = await import("@/server/lib/r2-cache");
    const cached = (await getCached(cacheKey)) as SerpLiveItem[] | null;
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists SERP items into R2 with a soft TTL.
 */
export async function setCachedSerp(
  params: SerpCacheParams,
  items: SerpLiveItem[],
  ttlSeconds = SERP_CACHE_TTL_SECONDS,
): Promise<void> {
  try {
    const cacheKey = await buildSerpCacheKey(params);
    if (!cacheKey) return;

    const { setCached } = await import("@/server/lib/r2-cache");
    await setCached(cacheKey, items, ttlSeconds);
  } catch {
    // Gracefully ignore cache write failure
  }
}
