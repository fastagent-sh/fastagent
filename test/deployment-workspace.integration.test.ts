import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leaseDeployment } from "../src/deploy/workspace.ts";
import { dirs, fixture } from "./deployment-workspace-fixtures.ts";

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

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
