import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { excludedRailwayContexts } from "../src/deploy/railway/upload.ts";
import { git } from "./github-standin.ts";

vi.mock("../src/cli/fail.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/fail.ts")>()),
  failStartup: (error: unknown): never => {
    throw error;
  },
}));
vi.mock("../src/deploy/railway/run.ts", () => ({
  deployRailwayRun: vi.fn(async () => {
    throw new Error("unexpected Railway driver call");
  }),
}));
const { railwayHost } = await import("../src/cli/commands/deploy/railway.ts");
const { planArtifacts, applyArtifactPlan } = await import("../src/cli/commands/deploy/shared.ts");

let root = "";
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function agent() {
  root = await mkdtemp(join(tmpdir(), "fa-railway-upload-"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
  const dir = join(root, "agent");
  await mkdir(dir);
  git(dir, "init", "-q");
  await writeFile(join(dir, "context.json"), JSON.stringify({ contexts: { acme: { github: "acme/context" } } }));
  await writeFile(join(dir, ".gitignore"), "/.contexts\n*.pem\n");
  return dir;
}

const files = [".contexts/acme/context.json", ".contexts/acme/.fastagent-context.json"];

describe("Railway upload ignores", () => {
  it("rejects a kept directory exclusion and a snapshot-only exclusion; a directory whitelist preserves upload", async () => {
    const dir = await agent();
    await writeFile(join(dir, ".railwayignore"), "/.contexts\n");
    expect(await excludedRailwayContexts(dir)).toEqual(files);
    await writeFile(join(dir, ".railwayignore"), "!/.contexts/\n**/.*.json\n");
    expect(await excludedRailwayContexts(dir)).toEqual([files[1]]);
    await writeFile(join(dir, ".railwayignore"), "!/.contexts/\n");
    expect(await excludedRailwayContexts(dir)).toEqual([]);
    await writeFile(join(dir, ".railwayignore"), "# no override\n!\n");
    expect(await excludedRailwayContexts(dir)).toEqual(files);
  });

  it("honors global, repository and nested ignore rules, with explicit custom overrides", async () => {
    const dir = await agent();
    const global = join(root, "global-ignore");
    await writeFile(global, "*.json\n");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.excludesfile");
    vi.stubEnv("GIT_CONFIG_VALUE_0", global);
    await writeFile(join(dir, ".railwayignore"), "!/.contexts/\n");
    expect(await excludedRailwayContexts(dir)).toEqual(files);
    await writeFile(join(dir, ".railwayignore"), "!/.contexts/\n!/.contexts/**\n");
    expect(await excludedRailwayContexts(dir)).toEqual([]);
    await mkdir(join(dir, ".contexts", "acme"), { recursive: true });
    await writeFile(join(dir, ".contexts", "acme", ".railwayignore"), "/.fastagent-context.json\n");
    expect(await excludedRailwayContexts(dir)).toEqual([files[1]]);
  });

  it("blocks --run at the upload boundary while preserving the author's .railwayignore, even with --force", async () => {
    const dir = await agent();
    const owned = "/.contexts\n";
    await writeFile(join(dir, ".railwayignore"), owned);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx: Parameters<typeof railwayHost.deploy>[0] = {
      agentDir: dir,
      opts: { run: true, force: true },
      config: {},
      channels: [],
      webhookChannels: [],
      pre: {
        ok: true,
        messages: [],
        channels: [],
        hasCron: false,
        values: new Map(),
        valueFile: ".secrets/production/.env",
        modelAuth: undefined,
        boxLogin: undefined,
        declaredSecrets: [],
        secrets: [],
        container: {
          agent: "agent",
          releaseId: "test",
          version: "0.24.4",
          runtime: "node",
          hasPackageJson: false,
          hasLockfile: false,
        },
        port: 8787,
      },
      write: async (artifacts, options) => {
        await applyArtifactPlan(await planArtifacts(dir, artifacts, { ...options, isOurs: railwayHost.isOurs }));
      },
    };
    await expect(railwayHost.deploy(ctx)).rejects.toThrow(/Railway upload excludes required context files/);
    expect(await readFile(join(dir, ".railwayignore"), "utf8")).toBe(owned);
    expect(existsSync(join(dir, "Dockerfile"))).toBe(true);
  });
});
