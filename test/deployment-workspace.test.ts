import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimDeploymentStorage,
  assertStorageMounted,
  parseDeploymentRelease,
  releaseFromEnv,
} from "../src/deploy/workspace.ts";
import { dirs, release, fixture } from "./deployment-workspace-fixtures.ts";

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("deployed storage", () => {
  it("is claimed by its agent across releases, and nothing on it is touched", async () => {
    const { root } = await fixture();
    for (const dir of [".state", ".secrets"]) await mkdir(join(root, dir));
    await writeFile(join(root, ".state/session.json"), "conversation");
    await writeFile(join(root, ".secrets/auth.json"), "rotated credential");
    await writeFile(join(root, "work.md"), "the agent's work");
    await claimDeploymentStorage(root, release("one"));
    await claimDeploymentStorage(root, release("one")); // a restart of the same release
    await claimDeploymentStorage(root, release("two"));
    expect(JSON.parse(await readFile(join(root, ".deployment/applied.json"), "utf8"))).toEqual(release("two"));
    expect(await readFile(join(root, ".state/session.json"), "utf8")).toBe("conversation");
    expect(await readFile(join(root, ".secrets/auth.json"), "utf8")).toBe("rotated credential");
    expect(await readFile(join(root, "work.md"), "utf8")).toBe("the agent's work");
  });

  it("refuses another agent's storage, and corrupt metadata", async () => {
    const { root } = await fixture();
    await claimDeploymentStorage(root, release("one"));
    await expect(claimDeploymentStorage(root, { ...release("two"), agent: "other" })).rejects.toThrow(
      "deployment selects other, but this storage belongs to fastagent",
    );
    await writeFile(join(root, ".deployment/applied.json"), "broken");
    await expect(claimDeploymentStorage(root, release("two"))).rejects.toThrow();
    // The record's agent name is one path segment.
    expect(() => parseDeploymentRelease(JSON.stringify({ ...release("one"), agent: "../outside" }))).toThrow();
  });
});

describe("storage boundary", () => {
  it("does not mistake a directory for a mounted volume", async () => {
    const { root } = await fixture();
    await expect(assertStorageMounted(root)).rejects.toThrow();
  });
});

describe("releaseFromEnv: what a deploy set on the box", () => {
  it("reads the release id and the instance's name", () => {
    expect(releaseFromEnv({ FASTAGENT_RELEASE_ID: "abc123", FASTAGENT_NAME: "reviewer" } as NodeJS.ProcessEnv)).toEqual(
      { version: 1, id: "abc123", agent: "reviewer" },
    );
  });

  it("refuses a box that has no name, which would leave its storage with no owner", () => {
    expect(() => releaseFromEnv({ FASTAGENT_RELEASE_ID: "abc123" } as NodeJS.ProcessEnv)).toThrow(
      "FASTAGENT_NAME is required for a deployment",
    );
  });

  it("refuses a name that is not one path segment", () => {
    expect(() =>
      releaseFromEnv({ FASTAGENT_RELEASE_ID: "abc123", FASTAGENT_NAME: "../outside" } as NodeJS.ProcessEnv),
    ).toThrow("invalid deployment release record");
  });
});

describe("start on a deployed box that lost the variables a deploy sets", () => {
  it("refuses to start, and a local start takes no storage", async () => {
    const { prepareStartWorkspace } = await import("../src/cli/commands/start.ts");
    const { root } = await fixture();
    vi.stubEnv("FASTAGENT_ROOT", root);
    try {
      // The image says it is a deployment; the platform's variables are gone. Running on regardless would start a
      // local-looking instance on a disk with no mount check, no lease and no owner.
      vi.stubEnv("FASTAGENT_DEPLOYED", "1");
      vi.stubEnv("FASTAGENT_RELEASE_ID", "");
      vi.stubEnv("FASTAGENT_NAME", "");
      await expect(prepareStartWorkspace("/app")).rejects.toThrow("FASTAGENT_RELEASE_ID is required for a deployment");
      vi.stubEnv("FASTAGENT_RELEASE_ID", "abc123");
      await expect(prepareStartWorkspace("/app")).rejects.toThrow("FASTAGENT_NAME is required for a deployment");
      // Not deployed: nothing is taken, nothing is required.
      vi.stubEnv("FASTAGENT_DEPLOYED", "");
      await expect(prepareStartWorkspace("/app")).resolves.toBe("/app");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
