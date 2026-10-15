import { describe, expect, it, vi } from "vitest";
import {
  CACHED_SERP_BILLING,
  getCachedSerp,
  setCachedSerp,
  type SerpCacheParams,
} from "./serpCache";

describe("custom serpCache extension", () => {
  const params: SerpCacheParams = {
    keyword: "partisi toilet",
    locationCode: 2360,
    languageCode: "id",
    device: "mobile",
    depth: 40,
  };

  it("exports a valid zero-cost canonical DataForSEO billing envelope", () => {
    expect(CACHED_SERP_BILLING).toEqual({
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      costUsd: 0,
    });
  });

  it("returns null gracefully when R2 environment is unavailable", async () => {
    const cached = await getCachedSerp(params);
    expect(cached).toBeNull();
  });

  it("ignores setCachedSerp gracefully when R2 is unavailable", async () => {
    await expect(setCachedSerp(params, [])).resolves.toBeUndefined();
  });
});
