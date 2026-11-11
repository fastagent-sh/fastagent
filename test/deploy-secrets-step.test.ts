import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploySecrets } from "../src/cli/commands/deploy/secrets-step.ts";
import type { Answerer } from "../src/cli/commands/deploy/shared.ts";
import type { SecretStore } from "../src/deploy/secret-store.ts";
import { selectAgentEnvironment } from "../src/paths.ts";

const prompts = vi.hoisted(() => ({
  confirmed: [] as boolean[],
  typed: [] as (string | symbol)[],
  asked: [] as string[],
}));
vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => typeof value === "symbol",
  confirm: async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    return prompts.confirmed.shift() ?? Symbol("cancel");
  },
  password: async ({ message }: { message: string }) => {
    prompts.asked.push(message);
    return prompts.typed.shift() ?? Symbol("cancel");
  },
}));

let dir: string;
let writes: Record<string, string>[];
let said: string[];
const target = (held: string[] = []): SecretStore => ({
  async exists() {
    return true;
  },
  async ensure() {},
  async names() {
    return new Set(held);
  },
  async write(values) {
    writes.push({ ...values });
  },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fa-secrets-step-"));
  await mkdir(join(dir, ".secrets"), { recursive: true });
  writes = [];
  said = [];
  prompts.confirmed.length = 0;
  prompts.typed.length = 0;
  prompts.asked.length = 0;
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  selectAgentEnvironment("production");
  vi.spyOn(console, "error").mockImplementation((line) => void said.push(String(line)));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.FASTAGENT_ENVIRONMENT;
});

const step = (answerer: Answerer, extra: Partial<Parameters<typeof deploySecrets>[0]> = {}) =>
  deploySecrets({
    host: "fly",
    label: "Fly",
    agentDir: dir,
    opts: {},
    answerer,
    api: { served: false, why: "no" },
    modelAuth: undefined,
    modelKey: { variables: [], required: false },
    declaredSecrets: [{ name: "GH_TOKEN", declaredIn: "tools/gh.ts", optional: false }],
    valuesFrom: "the environment",
    values: new Map(),
    ...extra,
  });

describe("a deploy's secrets step", () => {
  it("at a terminal asks for what the target lacks, hiding what is typed, and sets it", async () => {
    prompts.typed.push("ghp_typed");
    expect(await step({ kind: "terminal" })(target())).toBeUndefined();
    expect(prompts.asked).toEqual(["GH_TOKEN (required by tools/gh.ts)"]);
    expect(writes).toEqual([{ GH_TOKEN: "ghp_typed" }]);
  });

  it("offers the names its environment holds with one question first", async () => {
    prompts.confirmed.push(true);
    const values = new Map([["GH_TOKEN", "ghp_file"]]);
    expect(await step({ kind: "terminal" }, { values, opts: { fromEnv: true } })(target())).toBeUndefined();
    expect(prompts.asked).toEqual(["Fly lacks GH_TOKEN, which the environment holds. Set them on Fly from it?"]);
    expect(writes).toEqual([{ GH_TOKEN: "ghp_file" }]);
  });

  it("names the flag that gives the same source to `secrets push`: the file, or the environment which includes it", async () => {
    const values = new Map([["GH_TOKEN", "ghp_file"]]);
    const ticket = { kind: "ticket", step: {} } as unknown as Answerer;
    const viaFile = await step(ticket, { values, opts: { envFile: "prod.env" } })(target());
    expect(viaFile).toMatch(/`fastagent secrets push fly [^`]*--env-file prod\.env` sets the one/);
    const viaEnv = await step(ticket, { values, opts: { fromEnv: true } })(target());
    expect(viaEnv).toMatch(/--from-env` sets the one/);
    // Both: `push` reads one source a run and the file's values are not in the second process's environment, so each
    // is a command of its own, said as such.
    const both = await step(ticket, { values, opts: { fromEnv: true, envFile: "prod.env" } })(target());
    expect(both).toMatch(
      /`fastagent secrets push fly [^`]*--env-file prod\.env` and `fastagent secrets push fly [^`]*--from-env` set, each from its own source,/,
    );
    // Given nothing, a source is not offered: the environment is the shell's, and nothing was said to read it.
    const none = await step(ticket)(target());
    expect(none).toMatch(/`fastagent secrets push fly [^`]*--from-env` takes them from the environment/);
    expect(none).not.toContain("sets the one");
  });

  it("a cancelled prompt stops the deploy with that, and sets nothing", async () => {
    const out = await step({ kind: "terminal" })(target());
    expect(out).toBe("Fly's values could not be read or set: cancelled");
    expect(writes).toEqual([]);
  });

  it("in a coding agent's deploy nothing is asked: it stops naming the commands, this agent's and configuration's", async () => {
    const ticket = { kind: "ticket", step: {} } as unknown as Answerer;
    const out = await step(ticket, { opts: { config: "prod.json" } })(target());
    expect(prompts.asked).toEqual([]);
    expect(out).toContain("Fly has no value for: GH_TOKEN (required by tools/gh.ts)");
    expect(out).toMatch(/`fastagent secrets set fly GH_TOKEN [^`]* --config prod\.json`/);
    expect(writes).toEqual([]);
    expect(await step({ kind: "nobody" })(target())).toContain("fastagent secrets set fly GH_TOKEN");
  });

  it("makes the Agent API's key for a person at a terminal, once: shown, set on the target, and kept nowhere here", async () => {
    const out = await step({ kind: "terminal" }, { api: { served: true }, declaredSecrets: [] })(target());
    expect(out).toBeUndefined();
    expect(writes).toHaveLength(1);
    const [key] = Object.entries(writes[0] as Record<string, string>);
    expect(key?.[0]).toBe("FASTAGENT_API_KEY");
    expect(key?.[1]).toMatch(/^[\w-]{43}$/);
    const told = said.join("\n");
    expect(told).toContain(
      "made FASTAGENT_API_KEY for the Agent API and set it on Fly. It is shown once and kept nowhere here",
    );
    // The one place it is shown: the person who made it has to copy it.
    expect(told).toContain(`FASTAGENT_API_KEY=${key?.[1]}`);
    // No file of this machine holds it: not the development file, not the one `start` reads.
    for (const file of [".secrets/.env", ".secrets/production/.env"]) {
      await expect(readFile(join(dir, file), "utf8")).rejects.toThrow();
    }
  });

  it("makes none where nobody would see it: a CI job or a coding agent's run stops, naming `secrets set … --generate`", async () => {
    const ticket = { kind: "ticket", step: {} } as unknown as Answerer;
    for (const answerer of [{ kind: "nobody" }, ticket] as unknown as Answerer[]) {
      writes.length = 0;
      const out = await step(answerer, { api: { served: true }, declaredSecrets: [] })(target());
      expect(out).toContain("Fly has no value for: FASTAGENT_API_KEY");
      expect(out).toMatch(/`fastagent secrets set fly FASTAGENT_API_KEY [^`]* --generate`/);
      expect(writes).toEqual([]);
    }
  });

  it("a deployment made again gets the key its environment holds, with no question and no new key", async () => {
    const values = new Map([["FASTAGENT_API_KEY", "kept-key"]]);
    const left: string[] = [];
    const ticket = { kind: "ticket", step: { person: { afterwards: (line: string) => left.push(line) } } };
    for (const answerer of [{ kind: "nobody" }, { kind: "terminal" }, ticket] as unknown as Answerer[]) {
      writes.length = 0;
      said.length = 0;
      const out = await step(answerer, { api: { served: true }, declaredSecrets: [], values, opts: { fromEnv: true } })(
        target(),
      );
      expect(out).toBeUndefined();
      expect(writes).toEqual([{ FASTAGENT_API_KEY: "kept-key" }]);
      expect(prompts.asked).toEqual([]);
      expect(said.join("\n")).toContain(
        "set FASTAGENT_API_KEY on Fly from the environment, where an earlier deploy kept it",
      );
      expect(said.join("\n")).not.toContain("made FASTAGENT_API_KEY");
    }
    // It is done, not left for the person: a ticket's afterwards lists only what they still have to do.
    expect(left).toEqual([]);
    await expect(readFile(join(dir, ".secrets", "production", ".env"), "utf8")).rejects.toThrow();
  });

  it("makes no key when the target has one", async () => {
    await step({ kind: "terminal" }, { api: { served: true }, declaredSecrets: [] })(target(["FASTAGENT_API_KEY"]));
    expect(writes).toEqual([]);
    expect(
      await step({ kind: "nobody" }, { api: { served: true }, declaredSecrets: [] })(target(["FASTAGENT_API_KEY"])),
    ).toBeUndefined();
  });
});
