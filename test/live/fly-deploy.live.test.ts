/**
 * A real Fly deployment, created and destroyed: `deploy fly --run` provisions an app, a volume and
 * secrets, builds on Fly's remote builder, boots the machine, and then this tears all of it down.
 *
 * The read-only probe next door (fly.live.test.ts) checks that `flyctl` still prints what the driver
 * parses. This one checks the half no parser assertion can reach: that the sequence actually
 * provisions a working deployment — the remote build accepts our generated Dockerfile, the volume
 * mounts where the state root expects it, the secrets arrive so the container can reach a model, and
 * the machine answers on its deterministic `https://<app>.fly.dev`.
 *
 * COSTS REAL RESOURCES. The app name carries a per-run uuid because Fly app names are GLOBALLY
 * unique, and teardown runs even when the deploy failed — a half-provisioned app still holds the
 * model credential that `fly secrets import` just staged into it.
 *
 * Needs `FLY_API_TOKEN` with write scope, a model credential (`FASTAGENT_AUTH_PATH`), and `flyctl`.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent.ts";
import { waitForHealth } from "../../src/channels/wait-health.ts";
import { toFlyAppName } from "../../src/deploy/fly/plan.ts";
import { listHasName } from "../../src/deploy/fly/run.ts";
import { liveVersion, requireEnv } from "./env.ts";

// A container build's log is megabytes; execFile's 1 MB default would abort the deploy mid-flight.
const run = (file: string, args: string[], cwd?: string) =>
  promisify(execFile)(file, args, { ...(cwd ? { cwd } : {}), maxBuffer: 64 << 20 });
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("FLY_API_TOKEN", "a Fly API token WITH write scope — this probe creates and destroys an app");

/** Globally unique: Fly rejects a name another tenant already holds, and a collision here would make
 *  this probe destroy an app it did not create. Derived through the product's own slug rule so the
 *  name this file destroys is the one the deploy provisions. */
const APP = toFlyAppName(`fastagent-live-${randomUUID().slice(0, 8)}`);
const URL_BASE = `https://${APP}.fly.dev`;

let workspace = "";

beforeAll(async () => {
  // basename(workspace) IS the app name (deploy.ts: toFlyAppName(basename(workspace))), so the
  // directory is named deliberately rather than by mkdtemp.
  workspace = join(tmpdir(), APP);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(workspace, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      { name: "live-fly-probe", private: true, dependencies: { "@fastagent-sh/fastagent": await liveVersion() } },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  // Ask before destroying: a deploy that failed BEFORE `apps create` has nothing to remove, and an
  // unconditional destroy answers `Could not find App` — a teardown error loud enough to bury the
  // real failure it followed. A deploy that failed AFTER it still holds the staged model credential,
  // so the destroy itself stays mandatory and its failure is reported.
  const errors: unknown[] = [];
  try {
    const { stdout } = await run("flyctl", ["apps", "list", "--json"]);
    // `listHasName` THROWS on output it cannot read, which is what makes asking safe here: the answer
    // "not listed" now only ever means the host said so. Were it to answer `false` for an unreadable
    // list, a flyctl that renamed a field would skip the destroy, report nothing, and leak a running
    // app holding the model credential and serving `/invoke` unauthenticated.
    if (listHasName(stdout, APP)) await run("flyctl", ["apps", "destroy", APP, "--yes"]);
  } catch (error) {
    errors.push(error);
  }
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch((e: unknown) => errors.push(e));
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed — check whether app ${APP} still exists`);
}, 300_000);

/** POST one turn and return its SSE events (the built-in `/invoke`, mounted because no channel is declared). */
async function invoke(session: string, text: string): Promise<AgentEvent[]> {
  const response = await fetch(`${URL_BASE}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text }),
  });
  expect(response.status).toBe(200);
  return (await response.text())
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as AgentEvent);
}

const answerOf = (events: AgentEvent[]): string =>
  events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");

describe("deploy fly --run: a real app, provisioned and destroyed", () => {
  it("provisions, boots, and serves a turn on its fly.dev URL", async () => {
    // Every gate in the driver exits non-zero, so a refusal surfaces here as this call's rejection.
    // flyctl's own output is spliced in: execFile's error carries stderr but its message does not,
    // and "Command failed" is all an unattended nightly would otherwise report.
    try {
      await run(process.execPath, [CLI, "deploy", "fly", "--run"], workspace);
    } catch (error) {
      const { stderr, stdout } = error as { stderr?: string; stdout?: string };
      throw new Error(`deploy fly --run failed for ${APP}:\n${(stderr || stdout || String(error)).slice(-4000)}`);
    }

    // The URL is deterministic (run.ts builds it the same way), so reaching it proves the machine
    // is up under the name the driver provisioned — not merely that some deploy succeeded.
    expect(await waitForHealth(`${URL_BASE}/health`, 180_000, 3_000), `${URL_BASE}/health never came up`).toBe(true);

    const session = "live-fly";
    const first = await invoke(session, "Remember this number: 47. Reply with just: ok");
    expect(first.at(-1)).toMatchObject({ type: "completed" });

    // Restart BETWEEN the turns, which is what makes the next answer evidence about the VOLUME rather
    // than about the record store: a rolling restart replaces the machine's filesystem, so anything
    // that survives came off the `data` volume mounted at /data (fly.toml's `[mounts]`, the one piece
    // this driver creates in a step of its own). Without it both turns hit one running machine and a
    // container-local store would answer identically — the same reason docker.live.test.ts restarts.
    await run("flyctl", ["apps", "restart", APP]);
    expect(await waitForHealth(`${URL_BASE}/health`, 180_000, 3_000), `${URL_BASE}/health never came back`).toBe(true);

    const second = await invoke(session, "What number did I ask you to remember? Reply with digits only.");
    expect(second.at(-1)).toMatchObject({ type: "completed" });
    expect(answerOf(second)).toContain("47");
  }, 900_000);
});
