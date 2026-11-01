import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { openAgent } from "../src/harnesses/pi-durable/serve.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";
import { fauxAgent as agent, killWhileLingering, lingered, runInProcess, whileServed } from "./cli-run.ts";

/** The session id an invoke printed on stderr. */
function sessionOf(stderr: string): string {
  const id = /\[fastagent\] session (\S+) \(continue it with --session \1\)/.exec(stderr)?.[1];
  if (id === undefined) throw new Error(`no session id in: ${stderr}`);
  return id;
}

describe("cli: invoke", () => {
  it("--session continues the session an earlier run printed, beside a serve", async () => {
    const dir = await agent("fa-invoke-session-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["invoke", "hello", dir]);
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      const sessionId = sessionOf(first.stderr);
      const second = await runInProcess(["invoke", "--session", sessionId, "again", dir]);
      expect([second.code, second.stdout.trim(), sessionOf(second.stderr)], second.stderr).toEqual([
        0,
        "seen 2",
        sessionId,
      ]);
    });
  });

  it("a continued session answers with the model this run names", async () => {
    const dir = await agent("fa-invoke-model-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["invoke", "hello", dir]);
      expect(first.code, first.stderr).toBe(0);
      const sessionId = sessionOf(first.stderr);
      const switched = await runInProcess(["invoke", "--session", sessionId, "--model", "gw/m2", "and", dir]);
      expect([switched.code, switched.stdout.trim(), sessionOf(switched.stderr)], switched.stderr).toEqual([
        0,
        "seen 2 by m2",
        sessionId,
      ]);
    });
  });

  it("without --session, each run starts a session of its own", async () => {
    const dir = await agent("fa-invoke-fresh-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["invoke", "hello", dir]);
      const fresh = await runInProcess(["invoke", "hello", dir]);
      expect([first.code, fresh.code], `${first.stderr}\n${fresh.stderr}`).toEqual([0, 0]);
      expect([first.stdout.trim(), fresh.stdout.trim()]).toEqual(["seen 1", "seen 1"]);
      expect(sessionOf(fresh.stderr)).not.toBe(sessionOf(first.stderr));
    });
  });

  it("--json prints the message, tool events and its end on a continued session", async () => {
    const dir = await agent("fa-invoke-json-");
    const first = await runInProcess(["invoke", "hello", dir]);
    expect(first.code, first.stderr).toBe(0);
    const sessionId = sessionOf(first.stderr);
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

  it("ends the message a killed invoke left, so no later invoke runs it again", async () => {
    const dir = await agent("fa-invoke-killed-");
    await killWhileLingering(["invoke", "linger, then deploy to prod", dir], dir);
    const next = await runInProcess(["invoke", "hello", dir]);
    expect([next.code, next.stdout.trim()], next.stderr).toEqual([0, "seen 1"]);
    expect(next.stderr).toMatch(/aborted 1 message\(s\) an earlier process accepted and stopped before they ended/);
    expect((await runInProcess(["invoke", "hello again", dir])).stderr).not.toContain("aborted");
    expect(await lingered(dir)).toBe(1);
  });

  it("refuses a session it does not hold", async () => {
    const dir = await agent("fa-invoke-refused-");
    const unknown = await runInProcess(["invoke", "--session", "nope", "hello", dir]);
    expect([unknown.code, unknown.stdout]).toEqual([1, ""]);
    expect(unknown.stderr).toMatch(/--session nope: no such session in .*invoke\.sqlite/);
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
});

async function withServedAgent(during: (dir: string, url: string) => Promise<void>): Promise<void> {
  const dir = await agent("fa-invoke-url-");
  const opened = await openAgent(dir);
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
      const sessionId = sessionOf(first.stderr);
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
      expect([switched.code, switched.stdout.trim(), sessionOf(switched.stderr)], switched.stderr).toEqual([
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
      const sessionId = sessionOf(first.stderr);
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

  it("without --key, uses the first key in the production values", async () => {
    await withServedAgent(async (dir, url) => {
      await mkdir(join(dir, ".secrets", "production"), { recursive: true });
      await writeFile(join(dir, ".secrets", "production", ".env"), "FASTAGENT_API_KEY=the-next-key, a-retired-key\n");
      const keyed = await runInProcess(["invoke", "--url", url, "hello", dir]);
      expect([keyed.code, keyed.stdout.trim()], keyed.stderr).toEqual([0, "seen 1"]);
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
    const keyless = await runInProcess(["invoke", "--url", "http://127.0.0.1:9", "hello", dir]);
    expect([keyless.code, keyless.stderr]).toEqual([
      2,
      expect.stringMatching(
        /no key to call http:\/\/127\.0\.0\.1:9 with: pass --key, or set FASTAGENT_API_KEY in .*\.secrets\/production\/\.env/,
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
