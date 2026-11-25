import { describe, expect, it, vi } from "vitest";
import { getFleetMatrixTool, linkFleetRepositoryTool } from "./fleet-tools";
import { makeToolContext } from "./tool-test-support";

const hoisted = vi.hoisted(() => ({
  memberPublishRoot: ".",
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db/provider", () => ({
  getDatabaseProvider: () => "d1",
}));

const toolContext = makeToolContext({ organizationId: "shared-workspace" });

vi.mock("@/db", () => {
  const dummyChain: Record<string, unknown> = {
    innerJoin: () => dummyChain,
    leftJoin: () => dummyChain,
    where: () => dummyChain,
    orderBy: () => dummyChain,
    // oxlint-disable-next-line eslint-plugin-unicorn/no-thenable
    then: (resolve: (val: unknown) => void) => {
      resolve([
        {
          id: "roster_v1",
          approvedAt: "2026-11-20T00:00:00Z",
          domainCount: 1,
        },
      ]);
    },
    limit: (count?: number) => {
      if (count === 1) {
        return [
          {
            id: "member_1",
            enrollmentState: "active",
            projectId: "proj_1",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
            publishRoot: hoisted.memberPublishRoot,
            versionId: "roster_v1",
          },
        ];
      }
      return [];
    },
  };

  return {
    db: {
      select: () => ({ from: () => dummyChain }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: () => [
              {
                id: "member_1",
                repoName: vals.repoName ?? "cfpages-syamsulalam-net/kaca-co-id",
                publishRoot: vals.publishRoot ?? "dist",
                versionId: "roster_v1",
              },
            ],
          }),
        }),
      }),
    },
  };
});

describe("Fleet Repository & Matrix Tools", () => {
  describe("link_fleet_repository", () => {
    it("validates canonical domain input in link_fleet_repository schema", () => {
      const schema = linkFleetRepositoryTool.config.inputSchema;
      expect(schema.domain.safeParse("a.id").success).toBe(true);
      expect(schema.domain.safeParse("kaca.co.id").success).toBe(true);
      expect(schema.domain.safeParse("-invalid.com").success).toBe(false);
      expect(schema.domain.safeParse("https://kaca.co.id").success).toBe(false);
    });

    it("rejects non-operator caller with member role (Sol Round 22 F03)", async () => {
      const memberContext = makeToolContext({
        organizationId: "shared-workspace",
        role: "member",
      });
      await expect(
        linkFleetRepositoryTool.handler(
          {
            domain: "kaca.co.id",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
          },
          memberContext,
        ),
      ).rejects.toThrow(
        /linking fleet repositories requires 'owner' or 'admin' role/,
      );
    });

    it("rejects caller outside shared-workspace organization", async () => {
      const foreignContext = makeToolContext({
        organizationId: "foreign_org",
        role: "owner",
      });
      await expect(
        linkFleetRepositoryTool.handler(
          {
            domain: "kaca.co.id",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
          },
          foreignContext,
        ),
      ).rejects.toThrow(/shared-workspace/);
    });

    it("rejects invalid canonical domain in handler", async () => {
      await expect(
        linkFleetRepositoryTool.handler(
          {
            domain: "-invalid.com",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
          },
          toolContext,
        ),
      ).rejects.toThrow(/Invalid canonical hostname/);
    });

    it("successfully links repository mapping in effective roster (Sol Round 24 P1-02)", async () => {
      const res = await linkFleetRepositoryTool.handler(
        {
          domain: "kaca.co.id",
          repoName: "cfpages-syamsulalam-net/kaca-co-id",
          publishRoot: "dist",
        },
        toolContext,
      );
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent.status).toBe("linked");
      expect(res.structuredContent.publishRoot).toBe("dist");
    });

    it("returns unchanged when mapping matches active member in effective roster (Sol Round 24 P1-02)", async () => {
      const res = await linkFleetRepositoryTool.handler(
        {
          domain: "kaca.co.id",
          repoName: "cfpages-syamsulalam-net/kaca-co-id",
        },
        toolContext,
      );
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent.status).toBe("unchanged");
      expect(res.structuredContent.publishRoot).toBe(".");
    });

    it("handles normalized equivalent trailing-slash publishRoot via raw column CAS comparison (Sol V4-07)", async () => {
      const prevRoot = hoisted.memberPublishRoot;
      hoisted.memberPublishRoot = "public/";
      try {
        const res = await linkFleetRepositoryTool.handler(
          {
            domain: "kaca.co.id",
            repoName: "cfpages-syamsulalam-net/kaca-co-id",
            publishRoot: "public",
          },
          toolContext,
        );
        expect(res.structuredContent.status).toBe("unchanged");
        expect(res.structuredContent.publishRoot).toBe("public");
      } finally {
        hoisted.memberPublishRoot = prevRoot;
      }
    });
  });

  describe("get_fleet_matrix", () => {
    it("validates canonical domain input in get_fleet_matrix schema", () => {
      const schema = getFleetMatrixTool.config.inputSchema;
      expect(schema.domain.safeParse("a.id").success).toBe(true);
      expect(schema.domain.safeParse("kaca.co.id").success).toBe(true);
      expect(schema.domain.safeParse("-invalid.com").success).toBe(false);
    });

    it("rejects caller outside shared-workspace organization", async () => {
      const foreignContext = makeToolContext({ organizationId: "foreign_org" });
      await expect(
        getFleetMatrixTool.handler({}, foreignContext),
      ).rejects.toThrow(/shared-workspace/);
    });
  });
});
