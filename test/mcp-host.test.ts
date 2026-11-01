import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mcpAuthorization } from "../src/mcp/host.ts";
import { mcpGrantFile } from "../src/mcp/grants.ts";
import { log } from "../src/log.ts";
import * as valueFile from "../src/value-file.ts";
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
it("warns for an unprotected environment override without managing its ignore file", async () => {
  const secrets = join(dir, "operator-secrets");
  const { store } = mcpAuthorization(dir, { FASTAGENT_SECRETS_DIR: secrets }, join(dir, ".state"));
  const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
  await store.withGrant("one", (access) => access.write(mcpFixture().grant()));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("FASTAGENT_SECRETS_DIR"));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(secrets));
  expect(existsSync(join(secrets, ".gitignore"))).toBe(false);
  await writeFile(join(secrets, ".gitignore"), "mcp-auth.json\n");
  warning.mockClear();
  await store.withGrant("one", (access) => access.write(mcpFixture().grant()));
  expect(warning).not.toHaveBeenCalled();
  expect(await readFile(join(secrets, ".gitignore"), "utf8")).toBe("mcp-auth.json\n");
});
it("does not persist a grant if preparing Git protection fails", async () => {
  const failure = Object.assign(new Error("ignore file unavailable"), { code: "EIO" });
  vi.spyOn(valueFile, "prepareSecretsDirectory").mockRejectedValue(failure);
  const { store } = mcpAuthorization(dir, {}, join(dir, ".state"));
  await expect(store.withGrant("one", (access) => access.write(mcpFixture().grant()))).rejects.toBe(failure);
  expect(existsSync(join(dir, ".secrets", "mcp-auth.json"))).toBe(false);
});

it("leaves an explicit host store's path protection to its owner", async () => {
  const secrets = join(dir, ".secrets");
  const store = mcpGrantFile(join(secrets, "mcp-auth.json"));
  const auth = mcpAuthorization(dir, {}, join(dir, ".state"), { store, bindings: {} });
  expect(auth.store).toBe(store);
  expect(existsSync(secrets)).toBe(false);
  await auth.store.withGrant("one", (access) => access.write(mcpFixture().grant()));
  expect(existsSync(join(secrets, ".gitignore"))).toBe(false);
});
