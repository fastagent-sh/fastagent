import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openSource } from "./open-source.ts";
import { fauxAgent as agent, runInProcess, whileServed } from "./cli-run.ts";

vi.mock("../src/harnesses/pi-durable/storage.ts", () => import("./storage-no-wait.ts"));

/** The session id an invoke printed on stderr; a run that printed none says how it ended. */
function sessionOf(run: { code: number | null; stdout: string; stderr: string }): string {
  const id = /\[fastagent\] session (\S+) \(continue it with --session \1\)/.exec(run.stderr)?.[1];
  if (id === undefined) {
    throw new Error(
      `no session id: exit ${run.code}, stdout ${JSON.stringify(run.stdout)}, stderr ${JSON.stringify(run.stderr)}`,
    );
  }
  return id;
}

describe("cli: invoke", () => {
  it("--session continues the session an earlier run printed, beside a serve", async () => {
    const dir = await agent("fa-invoke-session-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["invoke", "hello", dir]);
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      const sessionId = sessionOf(first);
      const second = await runInProcess(["invoke", "--session", sessionId, "again", dir]);
      expect([second.code, second.stdout.trim(), sessionOf(second)], second.stderr).toEqual([0, "seen 2", sessionId]);
    });
  });

  it("a continued session answers with the model this run names", async () => {
    const dir = await agent("fa-invoke-model-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["invoke", "hello", dir]);
      expect(first.code, first.stderr).toBe(0);
      const sessionId = sessionOf(first);
      const switched = await runInProcess(["invoke", "--session", sessionId, "--model", "gw/m2", "and", dir]);
      expect([switched.code, switched.stdout.trim(), sessionOf(switched)], switched.stderr).toEqual([
        0,
        "seen 2 by m2",
        sessionId,
      ]);
    });
  });

  it("a model with no credential here says to sign in or set its key, not what a deployment needs", async () => {
    const dir = await agent("fa-invoke-auth-");
    const result = await runInProcess(["invoke", "--model", "openai/gpt-4o-mini", "hello", dir], undefined, {
      ...process.env,
      OPENAI_API_KEY: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("failed: auth_required");
    expect(result.stderr).toContain(
      "next: sign in with `fastagent login`, or set the provider's API key in .secrets/.env",
    );
  });

  it("without --session, each run starts a session of its own", async () => {
    const dir = await agent("fa-invoke-fresh-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["invoke", "hello", dir]);
      const fresh = await runInProcess(["invoke", "hello", dir]);
      expect([first.code, fresh.code], `${first.stderr}\n${fresh.stderr}`).toEqual([0, 0]);
      expect([first.stdout.trim(), fresh.stdout.trim()]).toEqual(["seen 1", "seen 1"]);
      expect(sessionOf(fresh)).not.toBe(sessionOf(first));
    });
  });

  it("--json prints the message, tool events and its end on a continued session", async () => {
    const dir = await agent("fa-invoke-json-");
    const first = await runInProcess(["invoke", "hello", dir]);
    expect(first.code, first.stderr).toBe(0);
    const sessionId = sessionOf(first);
    const json = await runInProcess(["invoke", "--session", sessionId, "--json", "use a tool", dir]);
    expect(json.code, json.stderr).toBe(0);
    const lines = json.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; name?: string; message?: { status?: string } });
    expect(lines[0]).toMatchObject({ type: "message", message: { sessionId } });
    expect(lines.find((line) => line.type === "tool_started")).toMatchObject({ name: "read" });
    expect(lines.at(-1)).toMatchObject({ type: "done", message: { status: "completed" } });
  });

  it("refuses to run while another invoke holds the storage", async () => {
    const dir = await agent("fa-invoke-busy-");
    const held = await openLockedStorage(join(resolveStateRoot(dir), "invoke.sqlite"), "posix", "the test");
    try {
      const busy = await runInProcess(["invoke", "hello", dir]);
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain("another `fastagent invoke` of this agent is running");
    } finally {
      await held.close(BACKGROUND_CONTEXT);
    }
  });

  it("refuses a session it does not hold", async () => {
    const dir = await agent("fa-invoke-refused-");
    const unknown = await runInProcess(["invoke", "--session", "nope", "hello", dir]);
    expect([unknown.code, unknown.stdout]).toEqual([1, ""]);
    expect(unknown.stderr).toMatch(/--session nope: no such session in .*invoke\.sqlite/);
  });
});

async function withServedAgent(during: (dir: string, url: string) => Promise<void>): Promise<void> {
  const dir = await agent("fa-invoke-url-");
  const opened = await openSource(dir);
  try {
    const service = await opened.serve({ apiKeys: ["the-key", "the-next-key"] });
    const url = `http://127.0.0.1:${await service.listen(0, "127.0.0.1")}`;
    await during(dir, url);
  } finally {
    await opened.close();
  }
}

describe("cli: invoke --url", () => {
  it("runs with and without --model while loading no local harness", async () => {
    await withServedAgent(async (dir, url) => {
      const blocker = join(dir, "refuse-harness.mjs");
      await writeFile(
        blocker,
        `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url.includes("/harnesses/") || url.includes("/node_modules/@earendil-works/")) {
      throw new Error("Remote invoke loaded a local harness: " + url);
    }
    return nextLoad(url, context);
  },
});\n`,
      );
      const env = {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(blocker).href}`,
      };
      const plain = await runInProcess(["invoke", "--url", url, "--key", "the-key", "hello", dir], undefined, env);
      expect([plain.code, plain.stdout.trim()], plain.stderr).toEqual([0, "seen 1"]);
      const selected = await runInProcess(
        ["invoke", "--url", url, "--key", "the-key", "--model", "gw/m2", "hello", dir],
        undefined,
        env,
      );
      expect([selected.code, selected.stdout.trim()], selected.stderr).toEqual([0, "seen 1 by m2"]);
    });
  });

  it("a model the deployment has no credential for says how to give it one, naming the deployment's commands", async () => {
    await withServedAgent(async (dir, url) => {
      const env = { ...process.env, OPENAI_API_KEY: "" };
      const result = await runInProcess(
        ["invoke", "--url", url, "--key", "the-key", "--model", "openai/gpt-4o-mini", "hello", dir],
        undefined,
        env,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("failed: auth_required");
      expect(result.stderr).toContain("next: give the deployment a credential: `fastagent secrets set <host>");
    });
  });

  it("rejects a malformed --model before trying the connection", async () => {
    const dir = await agent("fa-invoke-url-model-");
    const result = await runInProcess([
      "invoke",
      "--url",
      "http://127.0.0.1:9",
      "--key",
      "the-key",
      "--model",
      "missing-provider",
      "hello",
      dir,
    ]);
    expect([result.code, result.stdout]).toEqual([2, ""]);
    expect(result.stderr).toContain('--model must be "provider/modelId", got "missing-provider"');
  });

  it("continues a served session with the model this run names", async () => {
    await withServedAgent(async (dir, url) => {
      const first = await runInProcess(["invoke", "--url", url, "--key", "the-key", "hello", dir]);
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      const sessionId = sessionOf(first);
      const switched = await runInProcess([
        "invoke",
        "--url",
        url,
        "--key",
        "the-key",
        "--session",
        sessionId,
        "--model",
        "gw/m2",
        "and",
        dir,
      ]);
      expect([switched.code, switched.stdout.trim(), sessionOf(switched)], switched.stderr).toEqual([
        0,
        "seen 2 by m2",
        sessionId,
      ]);
    });
  });

  it("--json prints a served session's message and its end", async () => {
    await withServedAgent(async (dir, url) => {
      const first = await runInProcess(["invoke", "--url", url, "--key", "the-key", "hello", dir]);
      expect(first.code, first.stderr).toBe(0);
      const sessionId = sessionOf(first);
      const json = await runInProcess([
        "invoke",
        "--url",
        url,
        "--key",
        "the-key",
        "--json",
        "--session",
        sessionId,
        "again",
        dir,
      ]);
      const lines = json.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect([json.code, lines[0]?.type, lines.at(-1)], json.stderr).toEqual([
        0,
        "message",
        expect.objectContaining({ type: "done", message: expect.objectContaining({ status: "completed" }) }),
      ]);
    });
  });

  it("without --key, uses the first FASTAGENT_API_KEY of the environment, or of the file --env-file names, and of no default file", async () => {
    await withServedAgent(async (dir, url) => {
      const ambient = { ...process.env, FASTAGENT_API_KEY: "the-next-key, a-retired-key" };
      const keyed = await runInProcess(["invoke", "--url", url, "hello", dir], undefined, ambient);
      expect([keyed.code, keyed.stdout.trim()], keyed.stderr).toEqual([0, "seen 1"]);

      const file = join(dir, "api.env");
      await writeFile(file, "FASTAGENT_API_KEY=the-next-key, a-retired-key\n");
      const clean = { ...process.env };
      delete clean.FASTAGENT_API_KEY;
      const named = await runInProcess(["invoke", "--url", url, "--env-file", file, "hello", dir], undefined, clean);
      expect([named.code, named.stdout.trim()], named.stderr).toEqual([0, "seen 1"]);

      // The files of the project are not read: neither the development one, which holds the key `dev` serves with,
      // nor the one `start` reads.
      for (const own of [".secrets/.env", ".secrets/production/.env"]) {
        await mkdir(join(dir, dirname(own)), { recursive: true });
        await writeFile(join(dir, own), "FASTAGENT_API_KEY=the-next-key\n");
      }
      const none = await runInProcess(["invoke", "--url", url, "hello", dir], undefined, clean);
      expect(none.code).toBe(2);
    });
  });

  it("refuses a key the served instance does not hold", async () => {
    await withServedAgent(async (dir, url) => {
      const refused = await runInProcess(["invoke", "--url", url, "--key", "not-a-key", "hello", dir]);
      expect([refused.code, refused.stderr]).toEqual([1, expect.stringContaining("unauthorized: ")]);
    });
  });

  it("refuses a session the served instance does not hold", async () => {
    await withServedAgent(async (dir, url) => {
      const unknown = await runInProcess(["invoke", "--url", url, "--key", "the-key", "--session", "nope", "hi", dir]);
      expect([unknown.code, unknown.stderr]).toEqual([
        1,
        expect.stringContaining(`--session nope: no such session at ${url}`),
      ]);
    });
  });

  it("says where a key comes from when it has none, and takes --key only with --url", async () => {
    const dir = await agent("fa-invoke-url-nokey-");
    const clean = { ...process.env };
    delete clean.FASTAGENT_API_KEY;
    const keyless = await runInProcess(["invoke", "--url", "http://127.0.0.1:9", "hello", dir], undefined, clean);
    expect([keyless.code, keyless.stderr]).toEqual([
      2,
      expect.stringMatching(
        /no key to call http:\/\/127\.0\.0\.1:9 with: pass --key, or set FASTAGENT_API_KEY in the environment of this command/,
      ),
    ]);
    const stray = await runInProcess(["invoke", "--key", "k", "hello", dir]);
    expect([stray.code, stray.stderr]).toEqual([2, expect.stringContaining("--key is the key --url calls with")]);
    // Outside any agent there is no value file to read a key from: --key is how one is given.
    const nowhere = await mkdtemp(join(tmpdir(), "fa-invoke-url-nowhere-"));
    const outside = await runInProcess(["invoke", "--url", "http://127.0.0.1:9", "hello", nowhere]);
    expect([outside.code, outside.stderr]).toEqual([
      2,
      expect.stringContaining("no key to call http://127.0.0.1:9 with: pass --key"),
    ]);
    // Inside an agent's subdirectory: refused as every command refuses it, said, not thrown.
    await mkdir(join(dir, "notes"), { recursive: true });
    const inside = await runInProcess([
      "invoke",
      "--url",
      "http://127.0.0.1:9",
      "--key",
      "k",
      "hello",
      join(dir, "notes"),
    ]);
    expect([inside.code, inside.stderr.includes("    at ")], inside.stderr).toEqual([1, false]);
  });
});
