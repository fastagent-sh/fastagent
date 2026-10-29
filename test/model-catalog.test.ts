import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyModel, InMemoryCredentialStore, createProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runModels } from "../src/cli/commands/models.ts";
import { catalogsIn } from "../src/harnesses/models/catalog.ts";
import { listModels, modelsOver } from "../src/harnesses/models/models.ts";
import { openServing } from "../src/harnesses/pi-durable/serve.ts";
import { resolveStateRoot } from "../src/paths.ts";

vi.mock("../src/proxy.ts", () => ({ installProxyFetch: vi.fn() }));

const builtIn = modelsOver(new InMemoryCredentialStore()).getModels("openai")[0] as AnyModel;
/** A model pi publishes after this pi-ai was built. */
const released = { ...builtIn, id: "gpt-released" };

interface Answer {
  status: number;
  body?: unknown;
  lastModified?: Date;
  etag?: string;
}

/** pi.dev's catalog as a local server: each request answers with `answer()`, or never when it returns undefined. */
async function catalogServer(answer: (request: IncomingMessage) => Answer | undefined) {
  const requests: { types: string | null; validator: string | undefined }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      types: new URL(request.url ?? "", "http://x").searchParams.get("types"),
      validator: request.headers["if-none-match"],
    });
    const answered = answer(request);
    if (answered === undefined) return;
    response.writeHead(answered.status, {
      "content-type": "application/json",
      ...(answered.lastModified ? { "last-modified": answered.lastModified.toUTCString() } : {}),
      ...(answered.etag ? { etag: answered.etag } : {}),
    });
    response.end(answered.body === undefined ? undefined : JSON.stringify(answered.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/models`, requests };
}

const servers: ReturnType<typeof createServer>[] = [];
const newer = () => new Date(Date.now() - 1000);
const stateDir = () => mkdtempSync(join(tmpdir(), "fa-catalog-"));

/** A process's view of the catalogs kept in `dir`: its models and their refresh. */
function opened(dir: string | undefined, url: string, timeoutMs?: number) {
  const catalogs = catalogsIn(dir, { url, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const models = modelsOver(new InMemoryCredentialStore(), [], catalogs);
  return { models, refresh: (force?: boolean) => catalogs.refresh(models, force ? { force } : {}) };
}

describe("model catalogs", () => {
  beforeEach(() => vi.stubEnv("FASTAGENT_OFFLINE", undefined));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) server.close().closeAllConnections();
  });

  it("lists what pi's published catalog adds, and keeps it for a start without the network", async () => {
    const radius = { ...builtIn, id: "radius-published", provider: "radius" };
    const video = { ...builtIn, id: "gpt-video", type: "video" };
    const pi = await catalogServer(() => ({
      status: 200,
      body: { openai: [released, video], radius: [radius] },
      lastModified: newer(),
    }));
    const dir = stateDir();
    const first = opened(dir, pi.url);
    expect(first.models.getModel("openai", "gpt-released")).toBeUndefined();
    expect(await first.refresh()).toBeUndefined();
    expect(first.models.getModel("openai", "gpt-released")).toMatchObject({ id: "gpt-released", provider: "openai" });
    expect(listModels(first.models)).toContain(`openai/${builtIn.id}`);
    expect(first.models.getAllModels("openai").map(({ id }) => id)).not.toContain("gpt-video");
    // Radius fetches its gateway's own list; pi's published one is not its gateway's.
    expect(first.models.getModel("radius", "radius-published")).toBeUndefined();
    expect(pi.requests).toEqual([{ types: "chat,image,classifier", validator: undefined }]);

    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    const next = opened(dir, pi.url);
    expect(await next.refresh(true)).toBeUndefined();
    expect(listModels(next.models)).toContain("openai/gpt-released");
    expect(pi.requests).toHaveLength(1);
  });

  it("adds nothing from a catalog no newer than this pi-ai's own data", async () => {
    const pi = await catalogServer(() => ({
      status: 200,
      body: { openai: [released] },
      lastModified: new Date("2020-01-01"),
    }));
    const stale = opened(stateDir(), pi.url);
    expect(await stale.refresh()).toBeUndefined();
    expect(stale.models.getModel("openai", "gpt-released")).toBeUndefined();
    expect(stale.models.getModel("openai", builtIn.id)).toBeDefined();
  });

  it("asks again only once the kept catalog is stale, or when forced, revalidating what it keeps", async () => {
    const pi = await catalogServer((request) =>
      request.headers["if-none-match"] === '"v1"'
        ? { status: 304 }
        : { status: 200, body: { openai: [released] }, lastModified: newer(), etag: '"v1"' },
    );
    const dir = stateDir();
    await opened(dir, pi.url).refresh();
    await opened(dir, pi.url).refresh();
    expect(pi.requests).toHaveLength(1);

    const forced = opened(dir, pi.url);
    expect(await forced.refresh(true)).toBeUndefined();
    expect(pi.requests.map(({ validator }) => validator)).toEqual([undefined, '"v1"']);
    expect(forced.models.getModel("openai", "gpt-released")).toBeDefined();

    const kept = join(dir, "published.json");
    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000 - 1;
    writeFileSync(kept, JSON.stringify({ ...JSON.parse(readFileSync(kept, "utf8")), checkedAt: fourHoursAgo }));
    await opened(dir, pi.url).refresh();
    // Unchanged (304), and checked: the next start asks nothing.
    await opened(dir, pi.url).refresh();
    expect(pi.requests).toHaveLength(3);
  });

  it("keeps the last list, and says why, when a refresh fails", async () => {
    let status = 200;
    const pi = await catalogServer(() => ({ status, body: { openai: [released] }, lastModified: newer() }));
    const dir = stateDir();
    await opened(dir, pi.url).refresh();
    status = 500;
    const failed = opened(dir, pi.url);
    expect(await failed.refresh(true)).toMatch(
      /^model lists not refreshed \(pi's published catalog: .* answered 500\)/,
    );
    expect(failed.models.getModel("openai", "gpt-released")).toBeDefined();

    const silent = await catalogServer(() => undefined);
    const waited = opened(dir, silent.url, 100);
    expect(await waited.refresh(true)).toMatch(/pi's published catalog: no answer within 0\.1s/);
    expect(waited.models.getModel("openai", "gpt-released")).toBeDefined();
  });

  it("names a kept catalog it cannot read, and how to repair it", async () => {
    const pi = await catalogServer(() => ({ status: 200, body: {}, lastModified: newer() }));
    const dir = stateDir();
    writeFileSync(join(dir, "published.json"), "{");
    expect(await opened(dir, pi.url).refresh()).toContain(`${join(dir, "published.json")} is not JSON: delete it`);
  });

  it("refreshes a provider that fetches its own list, with its credential, and keeps that list too", async () => {
    let fetches = 0;
    const own = createProvider({
      id: "own",
      auth: { apiKey: { name: "Own", resolve: async () => ({ auth: { apiKey: "k" } }) } },
      models: [],
      fetchModels: async () => {
        fetches += 1;
        return [{ ...builtIn, id: "own-1", provider: "own" }] as never;
      },
      api: { stream: () => never(), streamSimple: () => never() },
    });
    const pi = await catalogServer(() => ({ status: 200, body: {}, lastModified: newer() }));
    const dir = stateDir();
    const catalogs = catalogsIn(dir, { url: pi.url });
    const models = modelsOver(new InMemoryCredentialStore(), [own], catalogs);
    expect(models.getModel("own", "own-1")).toBeUndefined();
    expect(await catalogs.refresh(models)).toBeUndefined();
    expect(models.getModel("own", "own-1")).toBeDefined();
    expect(existsSync(join(dir, "providers", "own.json"))).toBe(true);

    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    const next = catalogsIn(dir, { url: pi.url });
    const restored = modelsOver(new InMemoryCredentialStore(), [own], next);
    await next.refresh(restored);
    expect(restored.getModel("own", "own-1")).toBeDefined();
    expect(fetches).toBe(1);
  });

  it("an agent opens on a model only the published catalog has: the Agent reads the lists its report reads", async () => {
    const agent = agentKeeping(released);
    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    const serving = await openServing(agent, { storage: "memory", credentialStore: new InMemoryCredentialStore() });
    try {
      expect(serving.models.models.getModel("openai", "gpt-released")).toBeDefined();
      expect((await serving.agent.info()).defaultModel).toEqual({ provider: "openai", modelId: "gpt-released" });
    } finally {
      await serving.agent.close();
    }
  });

  it("`models --refresh` asks however fresh the kept lists are, and exits 1, the kept list printed, when it cannot", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(agentKeeping(released));
    const fetched = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void printed.push(String(line)));
    const warned: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void warned.push(String(line)));
    try {
      await runModels("gpt-released");
      expect([fetched.mock.calls.length, process.exitCode]).toEqual([0, undefined]);
      await runModels("gpt-released", { refresh: true });
      expect([fetched.mock.calls.length, process.exitCode]).toEqual([1, 1]);
      expect(printed).toEqual(["openai/gpt-released", "openai/gpt-released"]);
      expect(warned.join("\n")).toMatch(/model lists not refreshed \(pi's published catalog: fetch failed\)/);
    } finally {
      process.exitCode = undefined;
    }
  });
});

/** An agent whose kept published catalog, fetched just now, lists `model`; its default model. */
function agentKeeping(model: AnyModel): string {
  const agent = mkdtempSync(join(tmpdir(), "fa-catalog-agent-"));
  writeFileSync(join(agent, "fastagent.config.ts"), `export default { model: "${model.provider}/${model.id}" };\n`);
  const kept = join(resolveStateRoot(agent), "models");
  mkdirSync(kept, { recursive: true });
  const published = { lastModified: Date.now(), checkedAt: Date.now(), models: { [model.provider]: [model] } };
  writeFileSync(join(kept, "published.json"), JSON.stringify(published));
  return agent;
}

function never(): never {
  throw new Error("this test sends no message");
}
