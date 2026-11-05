import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyReleaseEnv,
  claimDeploymentStorage,
  assertStorageMounted,
  leaseDeployment,
  parseDeploymentRelease,
  type DeploymentRelease,
} from "../src/deploy/workspace.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const release = (id: string): DeploymentRelease => ({ version: 1, id, agent: "fastagent" });
/** The host's storage (`root`). */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fa-deployed-storage-"));
  dirs.push(dir);
  const root = join(dir, "data");
  await mkdir(join(root, ".deployment"), { recursive: true });
  return { dir, root };
}

// Deployed storage is Linux-only; these checks exercise the real kernel and util-linux flock.
describe.runIf(process.platform === "linux")("deployment lease", () => {
  const openFiles = async () =>
    readdirSync("/proc/self/fd")
      .map((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`);
        } catch (error) {
          // Descriptor enumeration includes transient handles, including the directory reader itself.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        }
      })
      .join("\n");

  it("keeps a paused writer's lock and releases it after SIGKILL", async () => {
    const { root } = await fixture();
    const metadata = join(root, ".deployment");
    await mkdir(metadata, { recursive: true });
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { leaseDeployment } from ${JSON.stringify(new URL("../src/deploy/workspace.ts", import.meta.url).href)};
      await leaseDeployment(${JSON.stringify(metadata)});
      process.send("locked");
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = once(owner, "exit");
    let unexpectedLease: (() => Promise<void>) | undefined;
    try {
      await Promise.race([
        once(owner, "message"),
        exited.then(() => {
          throw new Error("lease owner exited before acquiring");
        }),
      ]);
      owner.kill("SIGSTOP");
      await expect(
        (async () => {
          unexpectedLease = await leaseDeployment(metadata, 1);
        })(),
      ).rejects.toThrow("could not acquire deployment lease");
      expect(await openFiles()).not.toContain(join(metadata, "lock"));
    } finally {
      await unexpectedLease?.();
      owner.kill("SIGKILL");
      await exited;
    }
    const release = await leaseDeployment(metadata);
    await release();
    await (await leaseDeployment(metadata))();
  }, 20_000);

  it("reports a missing flock binary without leaking its file descriptor", async () => {
    const { root } = await fixture();
    const metadata = join(root, ".deployment");
    await mkdir(metadata, { recursive: true });
    vi.stubEnv("PATH", "");
    try {
      await expect(leaseDeployment(metadata)).rejects.toThrow(/needs the `flock` binary/);
      expect(await openFiles()).not.toContain(join(metadata, "lock"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
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
    // The manifest's agent name is one path segment.
    expect(() => parseDeploymentRelease(JSON.stringify({ ...release("one"), agent: "../outside" }))).toThrow();
  });
});

describe("storage boundary", () => {
  it("does not mistake a directory for a mounted volume", async () => {
    const { root } = await fixture();
    await expect(assertStorageMounted(root)).rejects.toThrow();
  });
});

describe("applyReleaseEnv: the receiving half of the model chain", () => {
  // The deploy side decides the model; this is what makes it reach the process. It runs BEFORE the workspace's
  // own `.env` is read, so whatever it sets outranks a FASTAGENT_MODEL edited on the box.
  const withModel = (model?: string): DeploymentRelease => ({
    version: 1,
    id: "r1",
    agent: "fastagent",
    ...(model ? { model } : {}),
  });

  it("projects the release's model when the environment declares none", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyReleaseEnv(withModel("p/m"), env);
    expect(env.FASTAGENT_MODEL).toBe("p/m");
  });

  it("never overwrites a platform-set variable — the deployment declares only the half of the environment it can", () => {
    const env = { FASTAGENT_MODEL: "platform/one" } as NodeJS.ProcessEnv;
    applyReleaseEnv(withModel("p/m"), env);
    expect(env.FASTAGENT_MODEL).toBe("platform/one");
  });

  it("is a no-op when the release names no model", () => {
    const env = {} as NodeJS.ProcessEnv;
    applyReleaseEnv(withModel(), env);
    expect(env.FASTAGENT_MODEL).toBeUndefined();
  });

  it("reports the source that actually won, because the remedies differ", async () => {
    const { log } = await import("../src/log.ts");
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      applyReleaseEnv(withModel("p/m"), {} as NodeJS.ProcessEnv);
      expect(info.mock.calls.flat().join(" ")).toMatch(/the release manifest \(redeploy to change it\)/);

      info.mockClear();
      applyReleaseEnv(withModel("p/m"), { FASTAGENT_MODEL: "platform/one" } as NodeJS.ProcessEnv);
      expect(info.mock.calls.flat().join(" ")).toMatch(/outranks the release manifest/);

      // A redeploy would not change a value no release ever declared, so that half is dropped.
      info.mockClear();
      applyReleaseEnv(withModel(), { FASTAGENT_MODEL: "platform/one" } as NodeJS.ProcessEnv);
      const said = info.mock.calls.flat().join(" ");
      expect(said).toMatch(/already set in this environment/);
      expect(said).not.toMatch(/outranks the release manifest/);
    } finally {
      info.mockRestore();
    }
  });
});
