import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveStateRoot } from "../../../packages/fastagent/src/paths.ts";
import { unsupportedRuntime } from "../../../packages/fastagent/src/runtime.ts";
import { readFires } from "../../../packages/fastagent/src/schedule/state.ts";
import type { ClockStore } from "../../../packages/fastagent/src/schedule/clock.ts";
import { withInstanceClock } from "../../../packages/fastagent/src/harnesses/pi-durable/serve.ts";
import { clockStore } from "../../../packages/fastagent/src/harnesses/pi-durable/clock.ts";
import { openLockedStorage } from "../../../packages/fastagent/src/harnesses/pi-durable/storage.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { addWakeup } from "../../../packages/fastagent/src/schedule/wakeups.ts";
import { agentWorkspace, fauxAgent as agent, runInProcess, whileServed } from "../../doubles/cli-run.ts";
import { openSource } from "../../harnesses/open-source.ts";
import { servedPostgres } from "../../doubles/postgres-double.ts";

vi.mock(
  "../../../packages/fastagent/src/harnesses/pi-durable/storage.ts",
  () => import("../../doubles/storage-no-wait.ts"),
);

/** `work` over the clock of the CLI's instance of `dir`, which no process serves now. */
const clockOf = <T>(dir: string, work: (clock: ClockStore) => Promise<T>): Promise<T> =>
  withInstanceClock({ stateRoot: resolveStateRoot(dir), env: process.env }, work);

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

  it("schedules list reads a deployment's clock through its Agent API with --url", async () => {
    await withServedAgent(async (dir, url, opened) => {
      // Set in the served instance only: the instance a run of the CLI here would open is another.
      const clock = clockStore(opened.harness, BACKGROUND_CONTEXT);
      const added = await addWakeup(clock, {
        session: "chat:7",
        prompt: "ping",
        fireAt: new Date(Date.now() + 3_600_000),
      });
      if (!added.ok) throw new Error(added.error);
      const listed = await runInProcess(["-C", dir, "schedules", "list", "--url", url, "--key", "the-key", "--json"]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual({
        schedules: [],
        wakeups: [{ id: added.id, sessionId: "chat:7", fireAt: added.fireAt, prompt: "ping" }],
      });
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

      // Shared remotes.json resolution via --remote <name> for both invoke and schedules.
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

      const schedByRemote = await runInProcess(
        ["-C", outside, "schedules", "list", "--remote", "prod", "--json"],
        undefined,
        remoteEnv,
      );
      expect(schedByRemote.code, schedByRemote.stderr).toBe(0);
      expect(JSON.parse(schedByRemote.stdout)).toEqual({ schedules: [], wakeups: [] });

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
    });
  });
});

const schedule = (cron: string, extra = "") =>
  `export default { kind: "fastagent.schedule", cron: ${JSON.stringify(cron)}${extra}, prompt: "go" };\n`;

describe("cli: the agent's clock", () => {
  it("info lists the schedules with their next run, read from the directory, beside a serve that holds the instance", async () => {
    const dir = await agent("fa-clock-info-", {
      "src/schedules/daily.ts": schedule("0 9 * * *"),
      "src/schedules/weekly.ts":
        'export default { kind: "fastagent.schedule", cron: "0 9 * * 1", tz: "Asia/Shanghai", prompt: "review" };\n',
    });
    await whileServed(dir, async () => {
      const info = JSON.parse((await runInProcess(["-C", dir, "info", "--json"])).stdout) as {
        schedules: { name: string; tz: string | null; next: string | null }[];
      };
      expect(info.schedules.map((s) => [s.name, s.tz, typeof s.next])).toEqual([
        ["daily", null, "string"],
        ["weekly", "Asia/Shanghai", "string"],
      ]);
      expect((await runInProcess(["-C", dir, "info"])).stdout).toMatch(/daily \(next \S+\), weekly \(next \S+\)/);
    });
  });

  it("schedules list says each schedule's next and last run and the pending wake-ups, holding the instance", async () => {
    const dir = await agentWorkspace("fa-clock-list-", {
      "src/schedules/daily.ts": schedule("0 9 * * *"),
      "src/schedules/weekly.ts":
        'export default { kind: "fastagent.schedule", cron: "0 9 * * 1", tz: "Asia/Shanghai", prompt: "review" };\n',
    });
    const added = await clockOf(dir, async (clock) => {
      await clock.fires("daily", () => ({
        next: [{ slot: "2026-01-01T09:00:00.000Z", firedAt: "2026-01-01T09:00:00.000Z", outcome: "failed", ms: 12 }],
        result: undefined,
      }));
      return addWakeup(clock, {
        session: "chat:42",
        prompt: "check the deploy",
        fireAt: new Date(Date.now() + 3_600_000),
      });
    });
    if (!added.ok) throw new Error(added.error);

    const listed = await runInProcess(["-C", dir, "schedules", "list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const clock = JSON.parse(listed.stdout) as {
      schedules: { name: string; tz?: string; next?: string; last?: { outcome?: string } }[];
      wakeups: { id: string; sessionId: string; prompt: string }[];
    };
    expect(clock.schedules.map((s) => [s.name, s.tz, typeof s.next, s.last?.outcome])).toEqual([
      ["daily", undefined, "string", "failed"],
      ["weekly", "Asia/Shanghai", "string", undefined],
    ]);
    expect(clock.wakeups).toEqual([
      expect.objectContaining({ id: added.id, sessionId: "chat:42", prompt: "check the deploy" }),
    ]);
    const text = await runInProcess(["-C", dir, "schedules", "list"]);
    expect(text.stdout).toMatch(/daily {2}"0 9 \* \* \*" {2}next \S+ {2}last failed at 2026-01-01T09:00:00\.000Z/);
    expect(text.stdout).toContain(`${added.id}  ${added.fireAt}  session=chat:42  check the deploy`);
  });

  it("schedules list refuses an instance another process holds, naming it, exit 1", async () => {
    const dir = await agentWorkspace("fa-clock-held-", { "src/schedules/daily.ts": schedule("0 9 * * *") });
    const held = await openLockedStorage(join(resolveStateRoot(dir), "agent.sqlite"));
    try {
      const listed = await runInProcess(["-C", dir, "schedules", "list"]);
      expect([listed.code, listed.stdout]).toEqual([1, ""]);
      expect(listed.stderr).toMatch(/the storage \S+agent\.sqlite is held by another process/);
    } finally {
      await held.close(BACKGROUND_CONTEXT);
    }
  });

  it("schedules run continues its session and records interrupted and completed claims", async () => {
    const dir = await agent("fa-schedules-run-", {
      "src/schedules/digest.ts":
        'export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: "write the digest" };\n',
    });
    // A claim a stopped process left unsettled.
    await clockOf(dir, (clock) =>
      clock.fires("digest", () => ({
        next: [{ slot: "2026-01-01T09:00:00.000Z", firedAt: "2026-01-01T09:00:00.000Z" }],
        result: undefined,
      })),
    );

    const first = await runInProcess(["-C", dir, "schedules", "run", "digest"]);
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
    const second = await runInProcess(["-C", dir, "schedules", "run", "digest", "--json"]);
    expect(second.code, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      status: "completed",
      answer: { text: "seen 2" },
    });
    expect((await clockOf(dir, (clock) => readFires(clock, "digest"))).map((fire) => fire.outcome)).toEqual([
      "interrupted",
      "completed",
      "completed",
    ]);
  });

  it("goes through the serve that owns the instance: a schedule fired, a wake-up cancelled, a message sent", async () => {
    const dir = await agent("fa-clock-owner-", {
      "src/schedules/digest.ts":
        'export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: "write the digest" };\n',
    });
    const added = await clockOf(dir, (clock) =>
      addWakeup(clock, { session: "chat:42", prompt: "check the deploy", fireAt: new Date(Date.now() + 3_600_000) }),
    );
    if (!added.ok) throw new Error(added.error);
    await whileServed(dir, async () => {
      const fired = await runInProcess(["-C", dir, "schedules", "run", "digest"]);
      expect([fired.code, fired.stdout.trim()], fired.stderr).toEqual([0, "seen 1"]);
      const clock = JSON.parse((await runInProcess(["-C", dir, "schedules", "list", "--json"])).stdout) as {
        schedules: { name: string; last?: { outcome?: string } }[];
        wakeups: { id: string }[];
      };
      expect(clock.schedules).toEqual([
        expect.objectContaining({ name: "digest", last: expect.objectContaining({ outcome: "completed" }) }),
      ]);
      expect(clock.wakeups.map(({ id }) => id)).toEqual([added.id]);
      const unwoken = await runInProcess(["-C", dir, "schedules", "unwake", added.id]);
      expect([unwoken.code, unwoken.stdout], unwoken.stderr).toEqual([0, expect.stringContaining(added.id)]);
      const gone = await runInProcess(["-C", dir, "schedules", "unwake", added.id]);
      expect([gone.code, gone.stderr]).toEqual([
        1,
        expect.stringContaining(`not_found: no pending wake-up ${added.id}`),
      ]);
      const refused = await runInProcess(["-C", dir, "schedules", "run", "digest", "--model", "faux/m"]);
      expect([refused.code, refused.stderr]).toEqual([2, expect.stringContaining("drop --model")]);
    });
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
