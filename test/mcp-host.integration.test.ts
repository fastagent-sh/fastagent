import { execFileSync } from "node:child_process";

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mcpAuthorization } from "../src/mcp/host.ts";
import { mcpFixture } from "./mcp-fixture.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-host-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "core.excludesFile=/dev/null", "-C", dir, ...args], { encoding: "utf8" });

it.each(["dev", "production"])(
  "protects default %s grants before writes and repairs a removed ignore file",
  async (environment) => {
    git("init", "-q", "--template=");
    const secrets = join(dir, ".secrets", ...(environment === "production" ? ["production"] : []));
    const file = join(secrets, "mcp-auth.json");
    const { store } = mcpAuthorization(dir, { FASTAGENT_ENVIRONMENT: environment }, join(dir, ".state"));
    expect(await store.read("one")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(existsSync(secrets)).toBe(false);
    const record = mcpFixture().grant();
    await store.withGrant("one", async (access) => {
      await access.write(record);
      expect(git("ls-files", "--others", "--exclude-standard", "--", relative(dir, file))).toBe("");
      await rm(join(secrets, ".gitignore"));
      await access.write({ ...record, status: "refreshing" });
      expect(git("ls-files", "--others", "--exclude-standard", "--", relative(dir, file))).toBe("");
    });
    git("add", ".");
    expect(git("ls-files", "--", relative(dir, file))).toBe("");
  },
);
