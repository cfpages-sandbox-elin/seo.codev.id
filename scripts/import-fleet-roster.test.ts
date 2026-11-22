import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  approvalSchema,
  hashCanonicalRosterPlan,
  formatImporterError,
  CliUsageError,
  main,
} from "./import-fleet-roster";
import {
  FLEET_MANIFEST_MEMBERS,
  FLEET_MANIFEST_VERSION,
} from "../src/server/features/fleet/data/fleetManifest";

describe("import-fleet-roster approval validation and CLI boundaries (Sol F04, F07)", () => {
  it("validates well-formed approval schemas", () => {
    const valid = {
      organizationId: "org-test-1",
      versionTag: FLEET_MANIFEST_VERSION,
      rosterPlanSha256: hashCanonicalRosterPlan(
        "org-test-1",
        FLEET_MANIFEST_MEMBERS,
      ),
      approvedBy: "Syamsul Alam (Owner)",
    };
    expect(approvalSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects approval with mismatched versionTag", () => {
    const invalid = {
      organizationId: "org-test-1",
      versionTag: "v0.9-draft",
    };
    expect(approvalSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects empty or whitespace-only organizationId", () => {
    const invalid = {
      organizationId: "   ",
      versionTag: FLEET_MANIFEST_VERSION,
    };
    expect(approvalSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects non-hex sha256 fingerprints", () => {
    const invalid = {
      organizationId: "org-test-1",
      versionTag: FLEET_MANIFEST_VERSION,
      rosterPlanSha256: "not-a-valid-sha256-hash",
    };
    expect(approvalSchema.safeParse(invalid).success).toBe(false);
  });

  it("computes deterministic roster plan sha256", () => {
    const hash1 = hashCanonicalRosterPlan("org-1", FLEET_MANIFEST_MEMBERS);
    const hash2 = hashCanonicalRosterPlan("org-1", FLEET_MANIFEST_MEMBERS);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    const hashOtherOrg = hashCanonicalRosterPlan(
      "org-2",
      FLEET_MANIFEST_MEMBERS,
    );
    expect(hashOtherOrg).not.toBe(hash1);
  });

  it("formats importer errors without leaking stack traces or raw byte dumps", () => {
    const usageErr = new CliUsageError("Missing required arguments");
    expect(formatImporterError(usageErr)).toBe("Missing required arguments");

    const genericErr = new Error("Connection failed");
    expect(formatImporterError(genericErr)).toBe("Error: Connection failed");
  });

  it("exits with code 0 on --help without touching database", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
    await main(["--help"]);
    expect(process.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("rejects missing arguments with CliUsageError", async () => {
    await expect(main([])).rejects.toThrow(CliUsageError);
    await expect(main(["org-1"])).rejects.toThrow(CliUsageError);
  });

  it("rejects padded organization identifiers", async () => {
    if (!existsSync("scratch")) mkdirSync("scratch", { recursive: true });
    const dummyApproval = "scratch/dummy-padded-approval.json";
    writeFileSync(
      dummyApproval,
      JSON.stringify({
        organizationId: "org-1",
        versionTag: FLEET_MANIFEST_VERSION,
        rosterPlanSha256: "0".repeat(64),
        approvedBy: "Owner",
      }),
    );
    try {
      await expect(
        main(["  org-1  ", "--approval", dummyApproval]),
      ).rejects.toThrow(/padded with whitespace/);
    } finally {
      if (existsSync(dummyApproval)) unlinkSync(dummyApproval);
    }
  });

  it("rejects non-existent approval files", async () => {
    await expect(
      main(["org-1", "--approval", "non-existent-approval-file.json"]),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects malformed JSON approval files", async () => {
    if (!existsSync("scratch")) mkdirSync("scratch", { recursive: true });
    const badJson = "scratch/bad.json";
    writeFileSync(badJson, "{ invalid json");
    try {
      await expect(main(["org-1", "--approval", badJson])).rejects.toThrow(
        /Malformed approval file/,
      );
    } finally {
      if (existsSync(badJson)) unlinkSync(badJson);
    }
  });

  it("rejects approval files targeting a different organization", async () => {
    if (!existsSync("scratch")) mkdirSync("scratch", { recursive: true });
    const mismatchedOrg = "scratch/mismatched-org.json";
    writeFileSync(
      mismatchedOrg,
      JSON.stringify({
        organizationId: "org-other",
        versionTag: FLEET_MANIFEST_VERSION,
        rosterPlanSha256: "0".repeat(64),
        approvedBy: "Owner",
      }),
    );
    try {
      await expect(
        main(["org-target", "--approval", mismatchedOrg]),
      ).rejects.toThrow(/Organization mismatch/);
    } finally {
      if (existsSync(mismatchedOrg)) unlinkSync(mismatchedOrg);
    }
  });

  it("rejects approval files with mismatched roster plan sha256", async () => {
    if (!existsSync("scratch")) mkdirSync("scratch", { recursive: true });
    const badHashApproval = "scratch/bad-hash.json";
    writeFileSync(
      badHashApproval,
      JSON.stringify({
        organizationId: "org-1",
        versionTag: FLEET_MANIFEST_VERSION,
        rosterPlanSha256: "0".repeat(64),
        approvedBy: "Owner",
      }),
    );
    try {
      await expect(
        main(["org-1", "--approval", badHashApproval]),
      ).rejects.toThrow(/Approval does not match the target roster plan/);
    } finally {
      if (existsSync(badHashApproval)) unlinkSync(badHashApproval);
    }
  });
});
