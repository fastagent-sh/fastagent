import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveStateRoot } from "../../../src/paths.ts";
import { addWakeup } from "../../../src/schedule/wakeups.ts";
import { agentWorkspace, fauxAgent as agent, runInProcess, whileServed } from "../../doubles/cli-run.ts";
import { openSource } from "../../harnesses/open-source.ts";

vi.mock("../../../src/harnesses/pi-durable/storage.ts", () => import("../../doubles/storage-no-wait.ts"));

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

  it("refuses a key the served instance does not hold", async () => {
    await withServedAgent(async (dir, url) => {
      const refused = await runInProcess(["invoke", "--url", url, "--key", "not-a-key", "hello", dir]);
      expect([refused.code, refused.stderr]).toEqual([1, expect.stringContaining("unauthorized: ")]);
    });
  });
});

const schedule = (cron: string, extra = "") =>
  `export default { kind: "fastagent.schedule", cron: ${JSON.stringify(cron)}${extra}, prompt: "go" };\n`;

describe("cli: schedules", () => {
  it("schedules list reads BOTH owners: the declared schedules and the agent's own pending wake-ups", async () => {
    const dir = await agentWorkspace("fa-list-", {
      "src/schedules/daily.ts": schedule("0 9 * * *"),
      "src/schedules/weekly.ts": `export default {
  kind: "fastagent.needs",
  secrets: [{ name: "FA_TEST_ABSENT", optional: false }],
  build: () => ({ kind: "fastagent.schedule", cron: "0 9 * * 1", tz: "Asia/Shanghai", prompt: "review" }),
};\n`,
    });
    const claims = join(dir, ".fastagent", "dev", ".state", "schedule", "claims", "daily");
    await mkdir(claims, { recursive: true });
    await writeFile(
      join(claims, "2026-01-01T09-00-00-000Z"),
      JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z", outcome: "failed", ms: 12 }),
    );
    const added = addWakeup(resolveStateRoot(dir), {
      session: "chat:42",
      prompt: "check the deploy",
      fireAt: new Date(Date.now() + 3_600_000),
    });
    if (!added.ok) throw new Error(added.error);

    const text = await runInProcess(["schedules", "list", dir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(
      /daily\s+next \S+\s+cron 0 9 \* \* \*\s+last 2026-01-01T09:00:00.000Z failed\s+session=\(none yet\)/,
    );
    expect(text.stdout).toMatch(/weekly\s+next \S+\s+cron 0 9 \* \* 1 Asia\/Shanghai\s+never run/);
    expect(text.stdout).toContain(`wake ${added.id}`);
    expect(text.stdout).toContain("session=chat:42");

    const asJson = await runInProcess(["schedules", "list", "--json", dir]);
    const parsed = JSON.parse(asJson.stdout) as {
      schedules: { name: string; session: string | null; fires: { outcome?: string }[] }[];
      wakeups: { id: string }[];
    };
    expect(parsed.schedules.map((s) => [s.name, s.session, s.fires.map((f) => f.outcome)])).toEqual([
      ["daily", null, ["failed"]],
      ["weekly", null, []],
    ]);
    expect(parsed.wakeups.map((w) => w.id)).toEqual([added.id]);
  });

  it("schedules run continues its session and records interrupted and completed claims", async () => {
    const dir = await agent("fa-schedules-run-", {
      "src/schedules/digest.ts":
        'export default { kind: "fastagent.schedule", cron: "0 9 * * *", prompt: "write the digest" };\n',
    });
    const claims = join(resolveStateRoot(dir), "schedule", "claims", "digest");
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, "2026-01-01T09-00-00-000Z"), JSON.stringify({ firedAt: "2026-01-01T09:00:00.000Z" }));

    const first = await runInProcess(["schedules", "run", "digest", dir]);
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
    const second = await runInProcess(["schedules", "run", "digest", dir]);
    expect([second.code, second.stdout.trim()], second.stderr).toEqual([0, "seen 2"]);
    const listed = JSON.parse((await runInProcess(["schedules", "list", "--json", dir])).stdout) as {
      schedules: { name: string; session: string | null; fires: { outcome?: string }[] }[];
    };
    expect(listed.schedules[0]?.session).toEqual(expect.any(String));
    expect(listed.schedules[0]?.fires.map((fire) => fire.outcome)).toEqual(["interrupted", "completed", "completed"]);
  });
});

describe("cli: dev", () => {
  it("refuses with exit 2 when no model resolves and --no-input is set", async () => {
    const dir = await agentWorkspace("fa-cli-dev-");
    const env = { ...process.env };
    delete env.FASTAGENT_MODEL;
    const refused = await runInProcess(["dev", dir, "--no-input"], undefined, env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/missing model/);
  });
});
