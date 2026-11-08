import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_AUTH_PATH } from "../src/harnesses/models/credentials.ts";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { fauxAgent } from "./cli-run.ts";
import { openSource } from "./open-source.ts";

/**
 * What `openAgent` reads (SPEC §8): its inputs. The process and the machine are filled with decoys: a variable, a file
 * and a global credentials file for each thing an input is the answer to, so an open that consults any of them shows it.
 */
const PROVIDERS = ["anthropic", "openai", "groq", "mistral", "deepseek"];
const scratch: string[] = [];
const agents: LocalAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  await rm(GLOBAL_AUTH_PATH, { force: true });
  vi.unstubAllEnvs();
});

async function directory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function writeAuth(path: string, provider: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ [provider]: { type: "api_key", key: `key-of-${provider}` } }));
  return path;
}

async function open(options: Parameters<typeof openSource>[1] & { dir?: string } = {}): Promise<LocalAgent> {
  const { dir = await fauxAgent("fa-open-inputs-"), ...rest } = options;
  const agent = await openSource(dir, { secrets: {}, env: {}, ...rest });
  agents.push(agent);
  return agent;
}

const providersOf = async (agent: LocalAgent) =>
  [...new Set((await agent.info()).models.map((model) => model.provider))].filter((name) => PROVIDERS.includes(name));

describe("the model credentials of an instance", () => {
  it("are the state directory's auth.json, over every file and variable that named one before", async () => {
    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    const dir = await fauxAgent("fa-open-inputs-");
    const stateDir = join(await directory("fa-open-state-"), "state");
    await writeAuth(join(stateDir, "auth.json"), "anthropic");
    vi.stubEnv("FASTAGENT_AUTH_PATH", await writeAuth(join(await directory("fa-decoy-"), "auth.json"), "openai"));
    const decoySecrets = await directory("fa-decoy-secrets-");
    await writeAuth(join(decoySecrets, "auth.json"), "groq");
    vi.stubEnv("FASTAGENT_SECRETS_DIR", decoySecrets);
    await writeAuth(join(dir, ".secrets", "auth.json"), "mistral");
    await writeAuth(GLOBAL_AUTH_PATH, "deepseek");
    const agent = await open({ dir, stateDir });
    expect(await providersOf(agent)).toEqual(["anthropic"]);
  });

  it("are none when the state directory has none, whatever the machine holds", async () => {
    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    await writeAuth(GLOBAL_AUTH_PATH, "deepseek");
    const agent = await open({ stateDir: join(await directory("fa-open-state-"), "state") });
    expect(await providersOf(agent)).toEqual([]);
  });
});

describe("what places and configures an instance", () => {
  it("is its inputs: a variable that names another root, state, configuration, model or name changes nothing", async () => {
    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    const decoy = await directory("fa-decoy-");
    const decoyConfig = join(decoy, "fastagent.json");
    await writeFile(decoyConfig, JSON.stringify({ name: "decoy-config", model: "decoy/model" }));
    for (const [name, value] of Object.entries({
      FASTAGENT_ROOT: join(decoy, "root"),
      FASTAGENT_STATE_DIR: join(decoy, "state"),
      FASTAGENT_SECRETS_DIR: join(decoy, "secrets"),
      FASTAGENT_CONFIG: decoyConfig,
      FASTAGENT_MODEL: "decoy/model",
      FASTAGENT_NAME: "decoy-name",
    })) {
      vi.stubEnv(name, value);
    }
    const stateDir = join(await directory("fa-open-state-"), "state");
    const agent = await open({ stateDir });
    const info = await agent.info();
    expect(info.name).not.toMatch(/decoy/);
    expect(info.defaultModel?.provider).not.toBe("decoy");
    expect(existsSync(join(stateDir, "agent.sqlite"))).toBe(true);
    expect(await readdir(decoy)).toEqual(["fastagent.json"]);
  });
});

/**
 * What an open, a serve and a message may read of the process's environment: the log level, and what is not FastAgent's
 * own read (SPEC §8). A model provider's SDK reads its own variables, which a faux provider does not exercise.
 */
const READ_ALLOWED = new Set([
  "FASTAGENT_LOG_LEVEL",
  // The MCP SDK reads these six to build a stdio server's default environment; FastAgent withholds every one of them.
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  // The runtime's own, under coverage.
  "NODE_V8_COVERAGE",
]);
const MCP_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const RECORDING_CONFIG = `import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }] });
faux.setResponses(
  Array.from({ length: 5 }, () => (context) => {
    writeFileSync(new URL("./prompt.txt", import.meta.url), getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage("ok");
  }),
);
export default { defaults: { model: "gw/m1" }, providers: [faux.provider] };
`;
const BOTH_WAYS = `export default {
  kind: "fastagent.by-ingress",
  webhook: () => ({ "POST /both": () => new Response("webhook") }),
  connection: { name: "both", connect: () => ({ ready: Promise.resolve(), closed: new Promise(() => {}) }) },
};
`;

describe("what an open, a serve and a message read of the process", () => {
  it("is the log level, over content, an MCP server, a channel that receives either way, and a turn", async () => {
    const content = await directory("fa-open-content-");
    const dir = await fauxAgent("fa-open-inputs-", {
      "context.json": JSON.stringify({
        mcpServers: { constructor: { command: process.execPath, args: [MCP_FIXTURE] } },
      }),
      "src/channels/both.mjs": BOTH_WAYS,
    });
    const stateDir = join(await directory("fa-open-state-"), "state");
    const real = process.env;
    const reads = new Set<string>();
    const watch = (key: string | symbol) => {
      if (typeof key === "string") reads.add(key);
    };
    process.env = new Proxy(real, {
      get(target, key) {
        watch(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        watch(key);
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        watch("<every variable>");
        return Reflect.ownKeys(target);
      },
    });
    try {
      const agent = await open({
        dir,
        stateDir,
        env: { PATH: real.PATH ?? "" },
        config: { content: { docs: { path: content } } },
      });
      const service = await agent.serve();
      expect((await service.fetch(new Request("http://x/health"))).status).toBe(200);
      const session = await agent.sessions.create();
      const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 30 });
      expect(message.status).toBe("completed");
      await service.close();
    } finally {
      process.env = real;
    }
    expect([...reads].filter((key) => !READ_ALLOWED.has(key)).sort()).toEqual([]);
  });

  it("does not take from it how a channel that names no way receives", async () => {
    vi.stubEnv("FASTAGENT_DEV", "1");
    const dir = await fauxAgent("fa-open-inputs-", { "src/channels/both.mjs": BOTH_WAYS });
    const stateDir = join(await directory("fa-open-state-"), "state");
    const service = await (await open({ dir, stateDir })).serve();
    expect((await service.fetch(new Request("http://x/both", { method: "POST" }))).status).toBe(200);
    await service.close();
  });

  it("does not take from it whether the agent is deployed, which its prompt says; `env` does", async () => {
    vi.stubEnv("FASTAGENT_RELEASE_FILE", "/etc/fastagent/fastagent.release.json");
    const dir = await fauxAgent("fa-open-inputs-", { "fastagent.config.ts": RECORDING_CONFIG });
    const promptOf = async (agent: LocalAgent) => {
      const session = await agent.sessions.create();
      await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 30 });
      return readFile(join(dir, "prompt.txt"), "utf8");
    };
    const state = async () => join(await directory("fa-open-state-"), "state");
    expect(await promptOf(await open({ dir, stateDir: await state() }))).not.toContain("survives restarts");
    const deployed = await open({
      dir,
      stateDir: await state(),
      env: { FASTAGENT_RELEASE_FILE: "/etc/fastagent/fastagent.release.json" },
    });
    expect(await promptOf(deployed)).toContain("survives restarts");
  });
});

describe("whether the model lists are refreshed over the network", () => {
  const asked = async (options: { offline?: boolean; env?: Record<string, string> }) => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      requests.push(String(input instanceof Request ? input.url : input));
      throw new Error("no network in a test");
    });
    await open({ stateDir: join(await directory("fa-open-state-"), "state"), ...options });
    vi.unstubAllGlobals();
    return requests.length;
  };

  it("is the `offline` option's, and neither the process's FASTAGENT_OFFLINE nor the env the agent's commands get", async () => {
    vi.stubEnv("FASTAGENT_OFFLINE", "1");
    expect(await asked({ offline: true })).toBe(0);
    expect(await asked({ offline: false })).toBeGreaterThan(0);
    expect(await asked({ offline: false, env: { FASTAGENT_OFFLINE: "1" } })).toBeGreaterThan(0);
  });
});
