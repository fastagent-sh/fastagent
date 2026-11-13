/**
 * A caller's own credential store (#652): an app keeps model credentials in its keychain (`openAgent`'s
 * `credentials`), so every rung that takes `authPath` also takes `credentialStore`, and then reads and writes ONLY that
 * store. The failure this guards is
 * silent: a path that still builds `fastagentCredentialStore` would put a credential back into a plain JSON file, or
 * read a login the caller never gave.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Credential, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_AUTH_PATH } from "../../../src/harnesses/models/credentials.ts";
import { modelEnvironment } from "../../../src/harnesses/models/environment.ts";
import { loginOver } from "../../../src/harnesses/models/login.ts";
import { openServing } from "../../../src/harnesses/pi-durable/serve.ts";
import { loadSourceDefinition } from "../../../src/harnesses/pi-durable/open.ts";
import { NOT_HOSTED } from "../../../src/serving-command.ts";

/** pi's in-memory store, with every call recorded. */
async function recordingStore(
  initial: Record<string, Credential> = {},
): Promise<CredentialStore & { calls: string[] }> {
  const inner = new InMemoryCredentialStore();
  for (const [id, credential] of Object.entries(initial)) await inner.modify(id, async () => credential);
  const calls: string[] = [];
  return {
    calls,
    read: (id, options) => {
      calls.push(`read ${id}`);
      return inner.read(id, options);
    },
    list: (options) => {
      calls.push("list");
      return inner.list(options);
    },
    modify: (id, fn, options) => {
      calls.push(`modify ${id}`);
      return inner.modify(id, fn, options);
    },
    delete: (id, options) => {
      calls.push(`delete ${id}`);
      return inner.delete(id, options);
    },
  };
}

/** An agent that runs anthropic, with no credentials file anywhere. */
async function agentWorkspace(): Promise<{ host: string; agent: string }> {
  const host = await mkdtemp(join(tmpdir(), "fa-credstore-"));
  const agent = join(host, "fastagent");
  await mkdir(agent);
  await writeFile(
    join(agent, "fastagent.config.ts"),
    `export default { defaults: { model: "anthropic/claude-sonnet-4-5" } };\n`,
  );
  return { host, agent };
}

/** Only a store can authenticate anthropic here, whatever this machine's environment holds. */
function noAnthropicEnv(): void {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    vi.stubEnv(name, undefined);
}

const noCredentialFiles = (agent: string) => {
  expect(existsSync(GLOBAL_AUTH_PATH), "the global credentials file").toBe(false);
  expect(existsSync(join(agent, ".secrets", "auth.json")), "the project credentials file").toBe(false);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a caller's credential store replaces the credentials file", () => {
  it("the opened agent authenticates from the store, and no file is read or written", async () => {
    noAnthropicEnv();
    const { agent } = await agentWorkspace();
    const store = await recordingStore({ anthropic: { type: "api_key", key: "sk-from-store" } });

    const opened = await openServing(await loadSourceDefinition(agent), {
      secrets: {},
      env: {},
      ownEnv: process.env,
      runsAs: NOT_HOSTED,
      credentialStore: store,
      storage: "memory",
    });
    try {
      expect(opened.models.auth).toBeUndefined(); // no file is in use, so none is reported
      expect((await opened.models.authStatus("anthropic")).source).toBe("stored credential");
      expect((await (await modelEnvironment(agent)).authStatus("anthropic")).source).toBeUndefined(); // the files hold nothing
      noCredentialFiles(agent);
    } finally {
      await opened.agent.close();
    }
  });

  it("refuses both sources, and a login with neither", async () => {
    const { host, agent } = await agentWorkspace();
    const both = { authPath: join(host, "auth.json"), credentialStore: await recordingStore() };
    await expect(
      openServing(await loadSourceDefinition(agent), {
        secrets: {},
        env: {},
        ownEnv: process.env,
        runsAs: NOT_HOSTED,
        ...both,
        storage: "memory",
      }),
    ).rejects.toThrow(/not both/);
    await expect(modelEnvironment(undefined, both)).rejects.toThrow(/not both/);
    const interaction = { signal: new AbortController().signal, notify: () => {}, prompt: async () => "" };
    await expect(loginOver({ provider: "openai", method: "api_key", interaction, ...both } as never)).rejects.toThrow(
      /not both/,
    );
    await expect(loginOver({ provider: "openai", method: "api_key", interaction } as never)).rejects.toThrow(
      /needs authPath or credentialStore/,
    );
  });
});
