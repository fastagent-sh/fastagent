import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
