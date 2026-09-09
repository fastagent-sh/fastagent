import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDeploymentRelease,
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
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fa-deployed-workspace-"));
  dirs.push(dir);
  const source = join(dir, "image"),
    root = join(dir, "data");
  await mkdir(join(source, "fastagent/skills"), { recursive: true });
  await mkdir(join(source, ".git"));
  await writeFile(join(source, ".git/HEAD"), "initial history");
  await writeFile(join(source, "project.txt"), "initial code");
  await writeFile(join(source, "fastagent/persona.md"), "release one");
  await writeFile(join(source, "fastagent/skills/old.md"), "old skill");
  return { dir, source, root };
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
      ).rejects.toThrow("could not acquire workspace lease");
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

describe("deployed workspace lifecycle", () => {
  it("preserves all live files on restart and replaces only the definition on a new release", async () => {
    const { source, root } = await fixture();
    const base = await applyDeploymentRelease(source, root, release("one"));
    await writeFile(join(base, "project.txt"), "uncommitted change");
    await writeFile(join(base, "untracked.txt"), "unfinished work");
    await writeFile(join(base, ".git/HEAD"), "new history");
    await writeFile(join(base, "fastagent/persona.md"), "self improvement");
    await symlink("project.txt", join(base, "project-link"));
    for (const dir of [".state", ".secrets"]) await mkdir(join(root, dir));
    await writeFile(join(root, ".state/session.json"), "conversation");
    await writeFile(join(root, ".secrets/auth.json"), "rotated credential");
    await applyDeploymentRelease(source, root, release("one"));
    expect(await readFile(join(base, "fastagent/persona.md"), "utf8")).toBe("self improvement");
    await writeFile(join(source, "project.txt"), "builder change");
    await writeFile(join(source, "fastagent/persona.md"), "release two");
    await rm(join(source, "fastagent/skills/old.md"));
    await applyDeploymentRelease(source, root, release("two"));
    expect(await readFile(join(base, "project.txt"), "utf8")).toBe("uncommitted change");
    expect(await readFile(join(base, "project-link"), "utf8")).toBe("uncommitted change");
    expect(await readFile(join(base, "untracked.txt"), "utf8")).toBe("unfinished work");
    expect(await readFile(join(base, ".git/HEAD"), "utf8")).toBe("new history");
    expect(await readFile(join(base, "fastagent/persona.md"), "utf8")).toBe("release two");
    expect(await readdir(join(base, "fastagent/skills"))).toEqual([]);
    expect(await readFile(join(root, ".state/session.json"), "utf8")).toBe("conversation");
    expect(await readFile(join(root, ".secrets/auth.json"), "utf8")).toBe("rotated credential");
  });

  it("recovers an interrupted definition update, whichever step it stopped at", async () => {
    for (const point of ["before-switch", "after-old-move", "after-new-move"]) {
      const { source, root } = await fixture();
      const base = await applyDeploymentRelease(source, root, release("one"));
      const meta = join(root, ".deployment");
      await mkdir(join(meta, "staged"));
      await writeFile(join(meta, "staged/persona.md"), "complete new definition");
      await writeFile(join(meta, "pending.json"), JSON.stringify({ release: release("two"), initial: false }));
      if (point !== "before-switch") await rename(join(base, "fastagent"), join(meta, "previous"));
      if (point === "after-new-move") await rename(join(meta, "staged"), join(base, "fastagent"));
      await applyDeploymentRelease(source, root, release("two"));
      expect(await readFile(join(base, "fastagent/persona.md"), "utf8")).toBe("complete new definition");
      expect(await readdir(meta)).toEqual(["applied.json"]);
    }
  });

  it("refuses an existing workspace without ownership metadata", async () => {
    const { source, root } = await fixture();
    await mkdir(join(root, "base"), { recursive: true });
    await writeFile(join(root, "base/precious"), "keep");
    await expect(applyDeploymentRelease(source, root, release("one"))).rejects.toThrow("unowned workspace");
    expect(await readFile(join(root, "base/precious"), "utf8")).toBe("keep");
  });

  it("refuses corrupt metadata and changing the selected agent", async () => {
    const { source, root } = await fixture();
    await applyDeploymentRelease(source, root, release("one"));
    await expect(applyDeploymentRelease(source, root, { ...release("two"), agent: "other" })).rejects.toThrow(
      "belongs to fastagent",
    );
    await writeFile(join(root, ".deployment/applied.json"), "broken");
    await expect(applyDeploymentRelease(source, root, release("two"))).rejects.toThrow();
    // The manifest names a directory the container joins onto the workspace root.
    expect(() => parseDeploymentRelease(JSON.stringify({ ...release("one"), agent: "../outside" }))).toThrow();
  });
});

describe("storage boundary", () => {
  it("does not mistake a directory for a mounted volume", async () => {
    const { root } = await fixture();
    await mkdir(root);
    await expect(assertStorageMounted(root)).rejects.toThrow();
  });
});
