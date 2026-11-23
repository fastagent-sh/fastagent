import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveStateRoot } from "../../../packages/fastagent/src/paths.ts";
import { unsupportedRuntime } from "../../../packages/fastagent/src/runtime.ts";
import { agentWorkspace, fauxAgent as agent, runInProcess, whileServed } from "../../doubles/cli-run.ts";
import { openSource } from "../../harnesses/open-source.ts";
import { servedPostgres } from "../../doubles/postgres-double.ts";

vi.mock(
  "../../../packages/fastagent/src/harnesses/pi-durable/storage.ts",
  () => import("../../doubles/storage-no-wait.ts"),
);

/** The session id an invoke printed on stderr; a run that printed none says how it ended. */
function sessionOf(run: { code: number | null; stdout: string; stderr: string }): string {
  const id = /\[fastagent\] session (\S+) \(continue it with (?:--(?:url|remote) \S+ )?--session \1\)/.exec(
    run.stderr,
  )?.[1];
  if (id === undefined) {
    throw new Error(
      `no session id: exit ${run.code}, stdout ${JSON.stringify(run.stdout)}, stderr ${JSON.stringify(run.stderr)}`,
    );
  }
  return id;
}

describe("the runtime the CLI runs on", () => {
  it("is Node from its floor: an older Node and Bun are refused, naming what to run", () => {
    expect(unsupportedRuntime({ node: "24.15.0" })).toBeUndefined();
    expect(unsupportedRuntime({ node: "24.4.0" })).toBe("fastagent needs Node 24.15.0 or later; this is 24.4.0");
    expect(unsupportedRuntime({ node: "24.15.0", bun: "1.4.0" })).toBe(
      "fastagent runs on Node 24.15.0 or later, not Bun (1.4.0)",
    );
  });
});

describe("cli: invoke", () => {
  it("goes through the serve that owns the instance, and --session continues a session an earlier run printed", async () => {
    const dir = await agent("fa-invoke-session-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["-C", dir, "invoke", "hello"]);
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      expect(first.stderr).toContain("through its serve at http://127.0.0.1:");
      const sessionId = sessionOf(first);
      const second = await runInProcess(["-C", dir, "invoke", "--session", sessionId, "again"]);
      expect([second.code, second.stdout.trim(), sessionOf(second)], second.stderr).toEqual([0, "seen 2", sessionId]);
    });
  });

  it("goes through a running serve before asking for a model of its own: the serve answers with its own", async () => {
    const dir = await agent("fa-invoke-owner-model-");
    const config = join(dir, "fastagent.config.ts");
    await writeFile(config, (await readFile(config, "utf8")).replace('model: "gw/m1", ', ""));
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    await whileServed(
      dir,
      async () => {
        const sent = await runInProcess(["-C", dir, "invoke", "hello", "--no-input"], undefined, env);
        expect([sent.code, sent.stdout.trim()], sent.stderr).toEqual([0, "seen 1"]);
      },
      { model: "gw/m1" },
    );
  });

  it("opens the instance itself when the owner it finds answers with another key: a stale claim, another serve", async () => {
    const dir = await agent("fa-invoke-stale-owner-");
    const other = await agent("fa-invoke-other-serve-");
    await whileServed(other, async (url) => {
      await mkdir(resolveStateRoot(dir), { recursive: true });
      await writeFile(join(resolveStateRoot(dir), "owner.json"), JSON.stringify({ url, key: "a killed owner's key" }));
      const sent = await runInProcess(["-C", dir, "invoke", "hello"]);
      expect([sent.code, sent.stdout.trim()], sent.stderr).toEqual([0, "seen 1"]);
      expect(sent.stderr).not.toContain("through its serve");
    });
  });

  it("without --session, each run starts a session of its own", async () => {
    const dir = await agent("fa-invoke-fresh-");
    await whileServed(dir, async () => {
      const first = await runInProcess(["-C", dir, "invoke", "hello"]);
      const fresh = await runInProcess(["-C", dir, "invoke", "hello"]);
      expect([first.code, fresh.code], `${first.stderr}\n${fresh.stderr}`).toEqual([0, 0]);
      expect([first.stdout.trim(), fresh.stdout.trim()]).toEqual(["seen 1", "seen 1"]);
      expect(sessionOf(fresh)).not.toBe(sessionOf(first));
    });
  });

  it("with --json in a TTY and no configured model, exits 2 without opening the interactive picker", async () => {
    const dir = await agentWorkspace("fa-invoke-json-tty-");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const refused = await runInProcess(["-C", dir, "invoke", "hello", "--json"], undefined, env, { tty: true });
    expect([refused.code, refused.stdout]).toEqual([2, ""]);
    expect(refused.stderr).toMatch(/missing model/);
    expect(refused.stderr).not.toContain("Choose a model");

    const configured = await agent("fa-invoke-json-tty-ok-");
    const ok = await runInProcess(["-C", configured, "invoke", "hello", "--json"], undefined, env, { tty: true });
    expect(ok.code, ok.stderr).toBe(0);
    const events = ok.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((e) => e.type)).toContain("message");
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("cli: an instance in PostgreSQL", () => {
  it("is not opened without the name it is given: exit 2, naming what to set", async () => {
    const dir = await agent("fa-invoke-postgres-unnamed-");
    const env: NodeJS.ProcessEnv = { ...process.env, FASTAGENT_DATABASE_URL: "postgres://agent@127.0.0.1:1/agents" };
    delete env.FASTAGENT_NAME;
    const run = await runInProcess(["-C", dir, "invoke", "hello"], undefined, env);
    expect([run.code, run.stdout]).toEqual([2, ""]);
    expect(run.stderr).toContain(
      "FASTAGENT_DATABASE_URL keeps the sessions in a database that instances share by name: name this one with --name <name> or FASTAGENT_NAME",
    );
  });

  it("keeps its sessions in the database FASTAGENT_DATABASE_URL names, by its name, whatever its state root", async () => {
    const postgres = await servedPostgres();
    try {
      const dir = await agent("fa-invoke-postgres-");
      const inRoot = (root: string) => ({
        ...process.env,
        FASTAGENT_DATABASE_URL: postgres.url,
        FASTAGENT_NAME: "support",
        FASTAGENT_ROOT: root,
      });
      const [rootA, rootB] = [
        mkdtempSync(join(tmpdir(), "fa-postgres-root-a-")),
        mkdtempSync(join(tmpdir(), "fa-postgres-root-b-")),
      ];
      const first = await runInProcess(["-C", dir, "invoke", "hello"], undefined, inRoot(rootA));
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      // A new machine's empty state root: the session is in the database.
      const next = await runInProcess(
        ["-C", dir, "invoke", "--session", sessionOf(first), "again"],
        undefined,
        inRoot(rootB),
      );
      expect([next.code, next.stdout.trim()], next.stderr).toEqual([0, "seen 2"]);
      expect(existsSync(join(rootA, ".state", "agent.sqlite"))).toBe(false);
      const info = JSON.parse((await runInProcess(["-C", dir, "info", "--json"], undefined, inRoot(rootB))).stdout) as {
        storage: string;
      };
      expect(info.storage).toBe(`PostgreSQL ${new URL(postgres.url).host}/postgres, instance "support"`);
    } finally {
      await postgres.close();
    }
  });
});

async function withServedAgent(
  during: (dir: string, url: string, opened: Awaited<ReturnType<typeof openSource>>) => Promise<void>,
): Promise<void> {
  const dir = await agent("fa-invoke-url-");
  const opened = await openSource(dir);
  try {
    const service = await opened.serve({ apiKeys: ["the-key", "the-next-key"] });
    const url = `http://127.0.0.1:${await service.listen(0, "127.0.0.1")}`;
    await during(dir, url, opened);
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
      const plain = await runInProcess(
        ["-C", dir, "invoke", "--url", url, "--key", "the-key", "hello"],
        undefined,
        env,
      );
      expect([plain.code, plain.stdout.trim()], plain.stderr).toEqual([0, "seen 1"]);
      const selected = await runInProcess(
        ["-C", dir, "invoke", "--url", url, "--key", "the-key", "--model", "gw/m2", "hello"],
        undefined,
        env,
      );
      expect([selected.code, selected.stdout.trim()], selected.stderr).toEqual([0, "seen 1 by m2"]);
    });
  });

  it("refuses a key the served instance does not hold, and honors FASTAGENT_API_KEY and --env-file outside any agent directory", async () => {
    await withServedAgent(async (dir, url) => {
      const refused = await runInProcess(["-C", dir, "invoke", "--url", url, "--key", "not-a-key", "hello"]);
      expect([refused.code, refused.stderr]).toEqual([1, expect.stringContaining("unauthorized: ")]);

      const outside = mkdtempSync(join(tmpdir(), "fa-outside-url-"));
      const fromEnv = await runInProcess(["-C", outside, "invoke", "--url", url, "hello"], undefined, {
        ...process.env,
        FASTAGENT_API_KEY: "the-key",
      });
      expect([fromEnv.code, fromEnv.stdout.trim()], fromEnv.stderr).toEqual([0, "seen 1"]);

      const envFile = join(outside, "prod.env");
      await writeFile(envFile, "FASTAGENT_API_KEY=the-next-key\n");
      const envWithoutKey = { ...process.env };
      delete envWithoutKey.FASTAGENT_API_KEY;
      const fromFile = await runInProcess(
        ["-C", outside, "invoke", "--url", url, "--env-file", envFile, "hello"],
        undefined,
        envWithoutKey,
      );
      expect([fromFile.code, fromFile.stdout.trim()], fromFile.stderr).toEqual([0, "seen 1"]);

      // Shared remotes.json resolution via --remote <name>.
      const remotesPath = join(outside, "remotes.json");
      await writeFile(
        remotesPath,
        JSON.stringify({
          default: "prod",
          remotes: {
            prod: { url, apiKey: "$PROD_AGENT_KEY" },
          },
        }),
      );
      const remoteEnv = { ...envWithoutKey, FASTAGENT_REMOTES_PATH: remotesPath, PROD_AGENT_KEY: "the-key" };
      const byRemote = await runInProcess(["-C", outside, "invoke", "--remote", "prod", "hello"], undefined, remoteEnv);
      expect([byRemote.code, byRemote.stdout.trim()], byRemote.stderr).toEqual([0, "seen 1"]);

      const both = await runInProcess(
        ["-C", outside, "invoke", "--url", url, "--remote", "prod", "hello"],
        undefined,
        remoteEnv,
      );
      expect([both.code, both.stderr]).toEqual([2, expect.stringContaining("either --url or --remote")]);

      const unknown = await runInProcess(
        ["-C", outside, "invoke", "--remote", "missing", "hello"],
        undefined,
        remoteEnv,
      );
      expect([unknown.code, unknown.stderr]).toEqual([2, expect.stringContaining("unknown remote")]);

      // --conversation reuses one session across single-call HTTP invokes.
      const conv1 = await runInProcess([
        "-C",
        outside,
        "invoke",
        "--url",
        url,
        "--key",
        "the-key",
        "--conversation",
        "daily-digest",
        "first",
      ]);
      expect([conv1.code, conv1.stdout.trim()], conv1.stderr).toEqual([0, "seen 1"]);
      const conv2 = await runInProcess([
        "-C",
        outside,
        "invoke",
        "--url",
        url,
        "--key",
        "the-key",
        "--conversation",
        "daily-digest",
        "second",
      ]);
      expect([conv2.code, conv2.stdout.trim()], conv2.stderr).toEqual([0, "seen 2"]);
      expect(sessionOf(conv2)).toBe(sessionOf(conv1));

      const conflict = await runInProcess([
        "-C",
        outside,
        "invoke",
        "--url",
        url,
        "--key",
        "the-key",
        "--session",
        sessionOf(conv1),
        "--conversation",
        "daily-digest",
        "bad",
      ]);
      expect([conflict.code, conflict.stderr]).toEqual([
        2,
        expect.stringContaining("either --session or --conversation"),
      ]);
    });
  });

  it("works from a host directory, agent root, or agent subdirectory and includes the remote target in the follow-up hint without printing the key", async () => {
    await withServedAgent(async (dir, url) => {
      const outside = mkdtempSync(join(tmpdir(), "fa-remote-host-"));
      const subdir = join(dir, "skills");
      await mkdir(subdir, { recursive: true });
      const envFile = join(outside, "remote.env");
      await writeFile(envFile, "FASTAGENT_API_KEY=the-next-key\n");

      const envWithKey = { ...process.env, FASTAGENT_API_KEY: "the-key" };
      const envWithoutKey = { ...process.env };
      delete envWithoutKey.FASTAGENT_API_KEY;

      for (const cwd of [outside, dir, subdir]) {
        const viaEnv = await runInProcess(["invoke", "--url", url, "hello"], cwd, envWithKey);
        expect([viaEnv.code, viaEnv.stdout.trim()], `${cwd}: ${viaEnv.stderr}`).toEqual([0, "seen 1"]);

        const viaFlag = await runInProcess(["invoke", "--url", url, "--key", "the-key", "hello"], cwd, envWithoutKey);
        expect([viaFlag.code, viaFlag.stdout.trim()], `${cwd}: ${viaFlag.stderr}`).toEqual([0, "seen 1"]);

        const viaFile = await runInProcess(
          ["invoke", "--url", url, "--env-file", envFile, "hello"],
          cwd,
          envWithoutKey,
        );
        expect([viaFile.code, viaFile.stdout.trim()], `${cwd}: ${viaFile.stderr}`).toEqual([0, "seen 1"]);
      }

      // Follow-up hint includes --url and --session, never prints the key, and continues the same remote session.
      const first = await runInProcess(["invoke", "--url", url, "--key", "the-key", "hello"], subdir, envWithoutKey);
      expect(first.code, first.stderr).toBe(0);
      const sid = sessionOf(first);
      expect(first.stderr).toContain(`(continue it with --url ${url} --session ${sid})`);
      expect(first.stderr).not.toContain("--key");
      expect(first.stderr).not.toContain("the-key");

      const followUp = await runInProcess(["invoke", "--url", url, "--session", sid, "again"], outside, envWithKey);
      expect([followUp.code, followUp.stdout.trim()], followUp.stderr).toEqual([0, "seen 2"]);
      expect(followUp.stderr).toContain(`(continue it with --url ${url} --session ${sid})`);

      // Named --remote works from an agent subdirectory and hints --remote <name> --session <id> without printing the key.
      const remotesPath = join(outside, "remotes.json");
      await writeFile(remotesPath, JSON.stringify({ remotes: { prod: { url, apiKey: "$PROD_AGENT_KEY" } } }));
      const remoteEnv = { ...envWithoutKey, FASTAGENT_REMOTES_PATH: remotesPath, PROD_AGENT_KEY: "the-key" };
      const viaRemote = await runInProcess(["invoke", "--remote", "prod", "hello"], subdir, remoteEnv);
      expect([viaRemote.code, viaRemote.stdout.trim()], viaRemote.stderr).toEqual([0, "seen 1"]);
      const remoteSid = sessionOf(viaRemote);
      expect(viaRemote.stderr).toContain(`(continue it with --remote prod --session ${remoteSid})`);
      expect(viaRemote.stderr).not.toContain("the-key");
    });
  });

  it("invoke --conversation persists its session mapping locally across cold runs", async () => {
    const dir = await agent("fa-cli-conv-local-");
    const first = await runInProcess(["-C", dir, "invoke", "--conversation", "ops-check", "hello"]);
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
    const second = await runInProcess(["-C", dir, "invoke", "--conversation", "ops-check", "again"]);
    expect([second.code, second.stdout.trim()], second.stderr).toEqual([0, "seen 2"]);
    expect(sessionOf(second)).toBe(sessionOf(first));
  });
});

describe("cli: remote", () => {
  it("adds, lists (redacting literal keys), sets default, invokes via --remote, and removes saved remotes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-cli-remote-"));
    const remotesPath = join(dir, "remotes.json");
    const env = { ...process.env, FASTAGENT_REMOTES_PATH: remotesPath };

    const empty = await runInProcess(["remote", "list", "--json"], dir, env);
    expect(empty.code, empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ path: remotesPath, remotes: {} });

    const added1 = await runInProcess(
      ["remote", "add", "prod", "https://prod.example.com", "--key", "$raw-secret-123"],
      dir,
      env,
    );
    expect(added1.code, added1.stderr).toBe(0);

    const added2 = await runInProcess(
      ["remote", "add", "staging", "https://staging.example.com", "--key", "$STAGING_KEY", "--default"],
      dir,
      env,
    );
    expect(added2.code, added2.stderr).toBe(0);

    const listedJson = await runInProcess(["remote", "list", "--json"], dir, env);
    expect(listedJson.code, listedJson.stderr).toBe(0);
    expect(listedJson.stdout).not.toContain("$raw-secret-123");
    expect(JSON.parse(listedJson.stdout)).toEqual({
      path: remotesPath,
      default: "staging",
      remotes: {
        prod: { type: "http", url: "https://prod.example.com", apiKey: "***" },
        staging: { type: "http", url: "https://staging.example.com", apiKey: "$STAGING_KEY" },
      },
    });

    const listedText = await runInProcess(["remote", "list"], dir, env);
    expect(listedText.code, listedText.stderr).toBe(0);
    expect(listedText.stdout).not.toContain("$raw-secret-123");
    expect(listedText.stdout).toContain("* staging");

    const setDef = await runInProcess(["remote", "default", "prod"], dir, env);
    expect(setDef.code, setDef.stderr).toBe(0);
    expect(JSON.parse((await runInProcess(["remote", "list", "--json"], dir, env)).stdout).default).toBe("prod");

    const badDef = await runInProcess(["remote", "default", "missing"], dir, env);
    expect([badDef.code, badDef.stderr]).toEqual([2, expect.stringContaining('Unknown remote "missing"')]);

    const removed = await runInProcess(["remote", "remove", "staging"], dir, env);
    expect(removed.code, removed.stderr).toBe(0);
    expect(
      Object.keys(JSON.parse((await runInProcess(["remote", "list", "--json"], dir, env)).stdout).remotes),
    ).toEqual(["prod"]);

    const badRemove = await runInProcess(["remote", "remove", "staging"], dir, env);
    expect([badRemove.code, badRemove.stderr]).toEqual([2, expect.stringContaining('unknown remote "staging"')]);
  });
});

describe("cli: dev", () => {
  it("refuses with exit 2 when no model resolves and --no-input is set", async () => {
    const dir = await agentWorkspace("fa-cli-dev-");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const refused = await runInProcess(["-C", dir, "dev", "--no-input"], undefined, env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/missing model/);
  });
});
