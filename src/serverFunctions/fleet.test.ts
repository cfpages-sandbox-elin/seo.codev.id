import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const hoisted = vi.hoisted(() => ({
  getOverview: vi.fn(),
  envValues: new Map<string, string>(),
  authenticatedContext: {
    organizationId: "org-1",
    role: "owner" as string | null,
  },
}));

vi.mock("@/server/features/fleet/services/FleetService", () => ({
  FleetService: { getOverview: hoisted.getOverview },
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn((key: string) =>
    Promise.resolve(hoisted.envValues.get(key) ?? null),
  ),
}));

vi.mock("@/serverFunctions/middleware", () => ({
  requireAuthenticatedContext: [],
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      validator: (validateFn: (input: unknown) => unknown) => ({
        handler:
          (
            handler: (input: {
              data: unknown;
              context: typeof hoisted.authenticatedContext;
            }) => unknown,
          ) =>
          ({ data }: { data?: unknown } = {}) =>
            handler({
              data: validateFn(data),
              context: hoisted.authenticatedContext,
            }),
      }),
    }),
  }),
}));

import { getFleetOverview } from "./fleet";

describe("getFleetOverview RPC entitlement gate (Sol F08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.envValues.clear();
    hoisted.envValues.set("FEATURE_FLEET_VIEW", "true");
    hoisted.envValues.set("FLEET_VIEW_ORGANIZATION_ID", "org-1");
    hoisted.authenticatedContext = { organizationId: "org-1", role: "owner" };
  });

  it("denies access when feature flag is disabled or absent", async () => {
    hoisted.envValues.set("FEATURE_FLEET_VIEW", "false");
    await expect(getFleetOverview()).rejects.toThrow(
      "Fleet view is unavailable",
    );
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });

  it("denies access when active organization does not match configured allowed organization", async () => {
    hoisted.authenticatedContext = {
      organizationId: "org-other",
      role: "owner",
    };
    await expect(getFleetOverview()).rejects.toThrow(
      "Fleet view is unavailable",
    );
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });

  it("denies access when role lacks fleet:view permission", async () => {
    hoisted.authenticatedContext = { organizationId: "org-1", role: "guest" };
    await expect(getFleetOverview()).rejects.toThrow(
      "Fleet view is unavailable",
    );
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });

  it("denies access when supplied expectedOrganizationId mismatches active organization", async () => {
    await expect(
      getFleetOverview({ data: { expectedOrganizationId: "org-mismatch" } }),
    ).rejects.toThrow("Fleet view is unavailable");
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });

  it("allows entitled reader (member) and delegates to FleetService.getOverview", async () => {
    hoisted.authenticatedContext = { organizationId: "org-1", role: "member" };
    hoisted.getOverview.mockResolvedValueOnce({ totalDomains: 87 });
    const result = await getFleetOverview({
      data: { expectedOrganizationId: "org-1" },
    });
    expect(hoisted.getOverview).toHaveBeenCalledWith("org-1");
    expect(result).toMatchObject({ totalDomains: 87 });
  });

  it("denies access when active organization context is missing", async () => {
    hoisted.authenticatedContext = { organizationId: "", role: "owner" };
    await expect(getFleetOverview()).rejects.toThrow(
      "Active organization required for fleet access",
    );
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });

  it("propagates NOT_FOUND when fleet roster approval is pending", async () => {
    hoisted.getOverview.mockRejectedValueOnce(
      new AppError("NOT_FOUND", "Fleet roster approval pending"),
    );
    await expect(
      getFleetOverview({ data: { expectedOrganizationId: "org-1" } }),
    ).rejects.toMatchObject({
      message: "Fleet roster approval pending",
      code: "NOT_FOUND",
    });
  });

  it("denies access when FEATURE_FLEET_VIEW is entirely absent", async () => {
    hoisted.envValues.delete("FEATURE_FLEET_VIEW");
    await expect(getFleetOverview()).rejects.toThrow(
      "Fleet view is unavailable",
    );
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });

  it("denies access when FLEET_VIEW_ORGANIZATION_ID is entirely absent", async () => {
    hoisted.envValues.delete("FLEET_VIEW_ORGANIZATION_ID");
    await expect(getFleetOverview()).rejects.toThrow(
      "Fleet view is unavailable",
    );
    expect(hoisted.getOverview).not.toHaveBeenCalled();
  });
});
