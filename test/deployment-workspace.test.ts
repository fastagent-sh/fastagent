import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDeploymentRelease,
  leaseDeployment,
  unmountWorkspace,
  mountTemporaryDirectories,
  parseDeploymentRelease,
  validateTemporaryDirectories,
  assertStorageMounted,
  type DeploymentRelease,
} from "../src/deploy/workspace.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const release = (id: string): DeploymentRelease => ({ version: 1, id, agent: "fastagent", temporaryDirectories: [] });
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
          unexpectedLease = await leaseDeployment(metadata);
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
  }, 45_000);

  it("reports a missing flock binary without leaking its file descriptor", async () => {
    const { root } = await fixture();
    const metadata = join(root, ".deployment");
    await mkdir(metadata, { recursive: true });
    vi.stubEnv("PATH", "");
    try {
      await expect(leaseDeployment(metadata)).rejects.toMatchObject({ code: "ENOENT" });
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

  it.each(["before-switch", "after-old-move", "after-new-move"])(
    "recovers an interrupted definition update: %s",
    async (point) => {
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
    },
  );

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
  });
});

describe("temporary directories", () => {
  it("detaches child mounts before their parents and never detaches storage", async () => {
    const unmount = vi.fn(async (_path: string) => {});
    const paths = [
      "/data",
      "/data/base/node_modules",
      "/data/base/node_modules/nested",
      "/data/base-other/node_modules",
    ];
    await unmountWorkspace("/data/base", paths, unmount);
    expect(unmount.mock.calls.map(([path]) => path)).toEqual([
      "/data/base/node_modules/nested",
      "/data/base/node_modules",
    ]);
    unmount.mockRejectedValueOnce(new Error("device busy"));
    await expect(unmountWorkspace("/data/base", paths, unmount)).rejects.toThrow("device busy");
  });

  it("keeps existing temporary dependencies on a process restart", async () => {
    const { dir, source, root } = await fixture();
    const base = await applyDeploymentRelease(source, root, release("one"));
    const temporary = join(dir, "tmp");
    await mkdir(join(temporary, "node_modules"), { recursive: true });
    await writeFile(join(temporary, "node_modules/keep"), "installed");
    await mountTemporaryDirectories(base, ["node_modules"], temporary, vi.fn());
    expect(await readFile(join(temporary, "node_modules/keep"), "utf8")).toBe("installed");
  });
  it.each(["../outside", "/absolute", ".", ".git", "x/.secrets", "a/../b", "fastagent/", "node_modules/", "x\0y"])(
    "rejects unsafe declaration %s",
    (path) => {
      expect(() => validateTemporaryDirectories([path])).toThrow("invalid temporary directory");
    },
  );
  it("rejects overlapping mounts and invalid manifests", () => {
    expect(() => validateTemporaryDirectories(["node_modules", "node_modules/cache"])).toThrow("overlapping");
    expect(() => parseDeploymentRelease(JSON.stringify({ ...release("one"), agent: "../outside" }))).toThrow();
    expect(() =>
      parseDeploymentRelease(JSON.stringify({ ...release("one"), temporaryDirectories: ["fastagent"] })),
    ).toThrow();
  });
  it("copies disposable contents before mounting and reports mount errors", async () => {
    const { dir, source, root } = await fixture();
    const base = await applyDeploymentRelease(source, root, release("one"));
    await mkdir(join(base, "node_modules"));
    await writeFile(join(base, "node_modules/installed"), "dependency");
    const temporary = join(dir, "tmp");
    const mount = vi.fn(async (from: string, to: string) => {
      expect(await readFile(join(from, "installed"), "utf8")).toBe("dependency");
      expect(await readdir(to)).toEqual([]);
      throw new Error("mount: permission denied");
    });
    await expect(mountTemporaryDirectories(base, ["node_modules"], temporary, mount)).rejects.toThrow(
      "permission denied",
    );
    expect(mount).toHaveBeenCalledOnce();
  });
  it("rejects symlink destinations without modifying their contents", async () => {
    const { dir, source, root } = await fixture();
    const base = await applyDeploymentRelease(source, root, release("one"));
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "keep");
    await symlink(outside, join(base, "node_modules"));
    const mount = vi.fn();
    await expect(mountTemporaryDirectories(base, ["node_modules"], join(dir, "tmp"), mount)).rejects.toThrow("symlink");
    expect(await readdir(outside)).toEqual(["keep"]);
    expect(mount).not.toHaveBeenCalled();
  });
  it("rejects a symlink ancestor before creating anything outside the workspace", async () => {
    const { dir, source, root } = await fixture();
    const base = await applyDeploymentRelease(source, root, release("one"));
    const outside = join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, join(base, "project"));
    await expect(
      mountTemporaryDirectories(base, ["project/new/node_modules"], join(dir, "tmp"), vi.fn()),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not mistake a directory for a mounted volume", async () => {
    const { root } = await fixture();
    await mkdir(root);
    await expect(assertStorageMounted(root)).rejects.toThrow();
  });
});
