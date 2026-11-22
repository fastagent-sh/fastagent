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
  const id = /\[fastagent\] session (\S+) \(continue it with --session \1\)/.exec(run.stderr)?.[1];
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

  it("invoke --conversation persists its session mapping locally across cold runs", async () => {
    const dir = await agent("fa-cli-conv-local-");
    const first = await runInProcess(["-C", dir, "invoke", "--conversation", "ops-check", "hello"]);
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
    const second = await runInProcess(["-C", dir, "invoke", "--conversation", "ops-check", "again"]);
    expect([second.code, second.stdout.trim()], second.stderr).toEqual([0, "seen 2"]);
    expect(sessionOf(second)).toBe(sessionOf(first));
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
