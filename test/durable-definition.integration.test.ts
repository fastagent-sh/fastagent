/**
 * A definition assembled onto pi-durable: the definition as a value, its declared secrets, the text read per request
 * (SYSTEM.md, AGENTS.md, skills loaded as pi loads them, prompt templates), and the code built with its secrets.
 */
import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { modelsOver } from "../src/harnesses/models/models.ts";
import { InMemoryCredentialStore, fauxAssistantMessage, type fauxProvider } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { DurableAgent } from "../src/harnesses/pi-durable/agent.ts";
import {
  type AssembleAgentOptions,
  buildDefinition,
  assembleAgent,
  loadSourceDefinition,
} from "../src/harnesses/pi-durable/open.ts";
import { openAgent, openServing } from "../src/harnesses/pi-durable/serve.ts";
import { DEV_SERVE_ENV, NOT_HOSTED } from "../src/serving-command.ts";
import { made, agentPackage, FILES, ENV, toolCall, lastToolResult } from "./durable-definition-fixtures.ts";

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("an agent definition on pi-durable", () => {
  describe("opened", () => {
    const opened: DurableAgent[] = [];
    afterAll(async () => {
      for (const agent of opened) await agent.close();
    });

    async function open(files = FILES, options: Partial<AssembleAgentOptions> = {}, opening = (dir: string) => dir) {
      const dir = agentPackage(files);
      const definition = await loadSourceDefinition(opening(dir));
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      const code = buildDefinition(definition, ENV);
      const agent = await assembleAgent(definition, {
        storage: new MemoryStorage(),
        runsAs: NOT_HOSTED,
        processEnv: {},
        models: modelsOver(new InMemoryCredentialStore(), code.providers),
        code,
        config: resolveConfig(definition),
        ...options,
      });
      opened.push(agent);
      return { dir, agent, faux };
    }

    async function ask(agent: DurableAgent, text: string) {
      return agent.messages.send({ sessionId: (await agent.sessions.create()).id, content: text }, { wait: 30 });
    }

    it("what it runs from a dev process is not dev: the bash tool's children do not inherit the mark", async () => {
      const { agent, faux } = await open();
      process.env[DEV_SERVE_ENV] = "1";
      try {
        faux.setResponses([
          () => toolCall("bash", { command: `printf "[%s]" "$${DEV_SERVE_ENV}"` }),
          (context) => fauxAssistantMessage(lastToolResult(context)),
        ]);
        expect((await ask(agent, "run it")).answer?.text).toContain("[]");
        expect(process.env[DEV_SERVE_ENV]).toBe("1"); // the serving process itself keeps it
      } finally {
        delete process.env[DEV_SERVE_ENV];
      }
    });
  });
});

describe("two agents in one process", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("each runs on its own secrets: its code, its commands and its model keys, the process's left alone", async () => {
    for (const name of ["WEATHER_KEY", "GH_TOKEN", "ANTHROPIC_API_KEY"]) vi.stubEnv(name, undefined);
    const before = { ...process.env };
    const agents = [
      {
        values: { WEATHER_KEY: "k-a", GH_TOKEN: "gh-a", ANTHROPIC_API_KEY: "sk-a" },
        key: "k-a",
        token: "gh-a",
        anthropic: true,
      },
      { values: { WEATHER_KEY: "k-b", GH_TOKEN: "gh-b" }, key: "k-b", token: "gh-b", anthropic: false },
    ].map((agent) => ({ ...agent, dir: agentPackage(FILES) }));
    const opened = [];
    for (const { dir, values } of agents) {
      opened.push(
        await openServing(await loadSourceDefinition(dir), {
          secrets: values,
          env: {},
          ownEnv: process.env,
          runsAs: NOT_HOSTED,
          storage: "memory",
          credentialStore: new InMemoryCredentialStore(),
        }),
      );
    }
    try {
      for (const [i, { dir, key, token, anthropic }] of agents.entries()) {
        const { agent, models } = opened[i] as (typeof opened)[number];
        const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
        const answer = async (call: ReturnType<typeof toolCall>) => {
          faux.setResponses([() => call, (context) => fauxAssistantMessage(lastToolResult(context))]);
          const sessionId = (await agent.sessions.create()).id;
          return (await agent.messages.send({ sessionId, content: "go" }, { wait: 30 })).answer?.text;
        };
        expect(await answer(toolCall("weather", { city: "London" }))).toBe(`London: sunny (key ${key}, region none)`);
        expect(await answer(toolCall("bash", { command: 'printf "[%s]" "$GH_TOKEN"' }))).toContain(`[${token}]`);
        expect((await models.authStatus("anthropic")).source).toBe(anthropic ? "ANTHROPIC_API_KEY" : undefined);
        // A request reads it too, as Bedrock reads its region and Azure its endpoint, not only the auth before it.
        faux.setResponses([(_context, options) => fauxAssistantMessage(`request env: ${options?.env?.GH_TOKEN}`)]);
        const sessionId = (await agent.sessions.create()).id;
        expect((await agent.messages.send({ sessionId, content: "go" }, { wait: 30 })).answer?.text).toBe(
          `request env: ${token}`,
        );
      }
      expect(process.env).toEqual(before);
    } finally {
      for (const { agent } of opened) await agent.close();
    }
  });
});

describe("the environment of the processes an agent starts", () => {
  it("is the base given, the declared secrets and the git ceiling: nothing else of the host's", async () => {
    vi.stubEnv("FA_HOST_ONLY", "stray-host-variable");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "stray-cloud-credential");
    const dir = agentPackage(FILES);
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const agent = await openAgent(await loadSourceDefinition(dir), {
      workdir,
      stateDir: join(dir, "state"),
      offline: true,
      env: { PATH: "/usr/bin:/bin", HOME: "/home/instance" },
      secrets: {
        WEATHER_KEY: "k",
        GH_TOKEN: "gh-declared",
        UNDECLARED_TOKEN: "not-declared",
        FA_HOST_ONLY: "also-given",
      },
    });
    try {
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      faux.setResponses([
        () => toolCall("bash", { command: "env" }),
        (context) => fauxAssistantMessage(lastToolResult(context)),
      ]);
      const sessionId = (await agent.sessions.create()).id;
      const end = await agent.messages.send({ sessionId, content: "go" }, { wait: 30 });
      const seen = Object.fromEntries(
        (end.answer?.text ?? "")
          .split("\n")
          .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      expect(seen).toMatchObject({
        PATH: "/usr/bin:/bin",
        HOME: "/home/instance",
        GH_TOKEN: "gh-declared",
        GIT_CEILING_DIRECTORIES: dir,
      });
      for (const name of ["UNDECLARED_TOKEN", "FA_HOST_ONLY", "AWS_SECRET_ACCESS_KEY", DEV_SERVE_ENV]) {
        expect(seen, name).not.toHaveProperty(name);
      }
    } finally {
      await agent.close();
    }
  });
});

describe("git discovery in the agent's working directory", () => {
  it("stops at the workspace: a repository around it is not the agent's to act on", async () => {
    const dir = agentPackage(FILES);
    execFileSync("git", ["init", "-q", dir]);
    const workdir = join(dir, "work");
    mkdirSync(workdir);
    const agent = await openAgent(await loadSourceDefinition(dir), {
      workdir,
      stateDir: join(dir, "state"),
      offline: true,
      env: { PATH: process.env.PATH ?? "" },
      secrets: ENV,
    });
    try {
      const { faux } = (await import(join(dir, "model.ts"))) as { faux: ReturnType<typeof fauxProvider> };
      const ask = async (command: string) => {
        faux.setResponses([
          () => toolCall("bash", { command }),
          (context) => fauxAssistantMessage(lastToolResult(context)),
        ]);
        const sessionId = (await agent.sessions.create()).id;
        return (await agent.messages.send({ sessionId, content: "go" }, { wait: 30 })).answer?.text ?? "";
      };
      expect(await ask("git rev-parse --show-toplevel 2>&1; true")).toContain("not a git repository");
      expect(await ask("git init -q . && git rev-parse --show-toplevel")).toContain("work");
    } finally {
      await agent.close();
    }
  });
});
