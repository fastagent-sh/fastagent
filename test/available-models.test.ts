/**
 * `availableModelsFromDir`: what an embedding client's model picker can offer for an agent directory.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createPiModelRuntime,
  globalCatalogPath,
  machineModelRuntime,
  refreshGlobalModelCatalog,
} from "../src/engines/pi/models.ts";
import { availableModelsFromDir, createPiAgentFromDir, refreshModelCatalogOver } from "../src/engines/pi/open.ts";

/** A workspace whose agent sits one level inside, with no model set and two custom endpoints. */
async function workspace(auth: string): Promise<{ dir: string; authPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fa-available-"));
  const agent = join(dir, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "fastagent.config.ts"), "export default {};");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        // Keyless local server: pi's docs prescribe a literal placeholder key.
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKey: "ollama",
          models: [{ id: "llama" }],
        },
        // Its key comes from an environment variable that is not set.
        gated: {
          baseUrl: "http://gw.invalid/v1",
          api: "openai-completions",
          apiKey: "$FA_AVAILABLE_TEST_UNSET_KEY",
          models: [{ id: "x" }],
        },
      },
    }),
  );
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, auth);
  return { dir, authPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("availableModelsFromDir", () => {
  it("lists what the agent can run now: configured endpoints and stored logins, nothing refreshed", async () => {
    // Only the stored login can list anthropic here, whatever this machine's environment holds.
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
      vi.stubEnv(name, undefined);
    const expiredOAuth = { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } };
    const { dir, authPath } = await workspace(JSON.stringify(expiredOAuth));
    const fetch = vi.spyOn(globalThis, "fetch");

    const specs = await availableModelsFromDir(dir, { authPath });

    expect(specs).toContain("local/llama");
    expect(specs).not.toContain("gated/x");
    expect(specs.some((spec) => spec.startsWith("anthropic/"))).toBe(true); // an expired login is still configured
    expect(fetch).not.toHaveBeenCalled(); // no token refresh, no provider call
    expect(specs).toEqual([...specs].sort());
  });

  it("a listed spec is one the opener runs with", async () => {
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
      vi.stubEnv(name, undefined);
    const { dir, authPath } = await workspace("{}");
    const specs = await availableModelsFromDir(dir, { authPath });
    expect(specs.some((s) => s.startsWith("anthropic/"))).toBe(false); // no stored login, no env key: not listed
    const [spec] = specs.filter((s) => s.startsWith("local/"));
    expect(spec).toBe("local/llama");

    const opened = await createPiAgentFromDir(dir, { model: spec, authPath });
    expect(opened.modelSpec).toBe("local/llama");
  });

  it("a corrupt credentials file reaches a throwing warn instead of reading as nothing configured", async () => {
    const { dir, authPath } = await workspace("{ not json");
    await expect(
      availableModelsFromDir(dir, {
        authPath,
        warn: (message) => {
          throw new Error(`credentials: ${message}`);
        },
      }),
    ).rejects.toThrow(/credentials:/);
  });
});

describe("refreshModelCatalog: a model newer than the bundled catalog", () => {
  const NEW = "claude-from-the-catalog";

  /** A catalog server that lists one model the bundled catalog lacks for anthropic, answering `status` for it. */
  async function catalogServer(status = 200): Promise<{ url: string; close: () => void }> {
    const [bundled] = (await machineModelRuntime()).getModels("anthropic");
    const server = createServer((req, res) => {
      if (req.url !== "/api/models/providers/anthropic") return void res.writeHead(404).end();
      // Newer than the bundled catalog, or pi ignores the entry.
      const lastModified = new Date(Date.now() + 86_400_000).toUTCString();
      res.writeHead(status, { "content-type": "application/json", "last-modified": lastModified });
      res.end(status === 200 ? JSON.stringify([{ ...bundled, id: NEW }]) : "denied");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  it("an agent's refresh lands in its own models-store.json: its list, its runs, and its deploy — no other agent's", async () => {
    // pi fetches a provider's catalog only with a usable credential for it.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const a = await workspace("{}");
    const b = await workspace("{}");
    expect(await availableModelsFromDir(a.dir, { authPath: a.authPath })).not.toContain(`anthropic/${NEW}`);

    const catalog = await catalogServer();
    try {
      await refreshModelCatalogOver(a.dir, { authPath: a.authPath }, catalog.url);
    } finally {
      catalog.close();
    }

    expect(existsSync(join(a.dir, "agent", "models-store.json"))).toBe(true);
    expect(await availableModelsFromDir(a.dir, { authPath: a.authPath })).toContain(`anthropic/${NEW}`);
    const opened = await createPiAgentFromDir(a.dir, { model: `anthropic/${NEW}`, authPath: a.authPath });
    expect(opened.modelSpec).toBe(`anthropic/${NEW}`); // listed, so it runs
    const deployed = await createPiModelRuntime({
      agentDir: join(a.dir, "agent"),
      credentials: new InMemoryCredentialStore(),
      machineLayer: false,
    });
    expect(deployed.getModel("anthropic", NEW)).toBeDefined(); // the file ships with the definition
    expect(await availableModelsFromDir(b.dir, { authPath: b.authPath })).not.toContain(`anthropic/${NEW}`);
  });

  it("a machine refresh (-g) reaches every agent here and `fastagent models`, and no deploy", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const b = await workspace("{}");
    const catalog = await catalogServer();
    try {
      await refreshGlobalModelCatalog({ catalogBaseUrl: catalog.url });
      expect(await availableModelsFromDir(b.dir, { authPath: b.authPath })).toContain(`anthropic/${NEW}`);
      expect((await machineModelRuntime()).getModel("anthropic", NEW)).toBeDefined();
      const deployed = await createPiModelRuntime({
        agentDir: join(b.dir, "agent"),
        credentials: new InMemoryCredentialStore(),
        machineLayer: false,
      });
      expect(deployed.getModel("anthropic", NEW)).toBeUndefined(); // the machine's catalog does not ship
    } finally {
      catalog.close();
      await rm(globalCatalogPath(), { force: true });
    }
  });

  it("a refresh that fails names the provider and why, instead of leaving the list silently stale", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const { dir, authPath } = await workspace("{}");
    const catalog = await catalogServer(403);
    try {
      await expect(refreshModelCatalogOver(dir, { authPath }, catalog.url)).rejects.toThrow(/anthropic: .*403/);
    } finally {
      catalog.close();
    }
  });

  it("PI_OFFLINE refuses the refresh rather than pretending it ran", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const { dir, authPath } = await workspace("{}");
    await expect(refreshModelCatalogOver(dir, { authPath }, "http://127.0.0.1:9")).rejects.toThrow(/PI_OFFLINE/);
  });
});
