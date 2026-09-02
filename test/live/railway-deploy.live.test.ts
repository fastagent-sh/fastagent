/**
 * A real Railway deployment, created and destroyed: `deploy railway --run` links or creates a project,
 * adds a service, sets variables, provisions a volume, builds, deploys, and mints a public domain.
 *
 * The read-only probe next door checks that the CLI still prints what the driver parses. This checks
 * the half no parser assertion reaches: that the sequence provisions something that WORKS — the build
 * accepts our generated Dockerfile via `railway.json`, the volume mounts where FASTAGENT_STATE_DIR
 * expects it, the model credential arrives, and the minted domain actually serves.
 *
 * It also covers a step with no read-only equivalent: `railway domain` is the driver's getter AND its
 * allocator (it mints one when the service has none), so the only way to observe it is to provision a
 * service to observe it on.
 *
 * COSTS REAL RESOURCES. Railway deletes SOFTLY — a destroyed project keeps appearing in
 * `railway list` with a `deletedAt` timestamp, so teardown verifies by that field rather than by
 * absence.
 *
 * Needs `RAILWAY_API_TOKEN` (ACCOUNT-scoped), a model credential, and the `railway` CLI.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForHealth } from "../../src/channels/wait-health.ts";
import { toRailwayName } from "../../src/deploy/railway/plan.ts";
import { CLI, answerOf, invoke, liveVersion, requireEnv, run } from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("RAILWAY_API_TOKEN", "an ACCOUNT-scoped Railway token — this probe creates and destroys a project");

/** Derived through the product's own slug rule (deploy.ts: `toRailwayName(basename(workspace))`), so the
 *  name this file tears down is the one the deploy provisions. Per-run uuid: concurrent runs must not
 *  collide, and teardown must never match another run's project. */
const PROJECT = toRailwayName(`fastagent-live-${randomUUID().slice(0, 8)}`);

let workspace = "";

beforeAll(async () => {
  workspace = join(tmpdir(), PROJECT);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(workspace, "fastagent.config.mjs"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      { name: "live-railway-probe", private: true, dependencies: { "@fastagent-sh/fastagent": await liveVersion() } },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    // `--project` is REQUIRED here even with `--yes`: outside a TTY the CLI refuses to infer which
    // project it is deleting (the docs call the flag optional). Measured, not read.
    const { stdout } = await run("railway", ["list", "--json"]);
    const projects = JSON.parse(stdout) as { id?: string; name?: string; deletedAt?: string | null }[];
    // Refuse a list we cannot read, which is what makes asking safe at all: "not mine" now only ever
    // means the account said so. A renamed field would otherwise match nothing, skip the delete
    // silently, and leak a billing project holding the model credential and serving `/invoke`
    // unauthenticated — the failure fly-deploy's throwing `listHasName` exists to prevent.
    if (!Array.isArray(projects) || projects.some((p) => typeof p.name !== "string"))
      throw new Error(`\`railway list --json\` is no longer a list of named projects: ${stdout.slice(0, 300)}`);
    // `== null`, not `=== null`: a MISSING deletedAt must read as alive, so an absent field ends in a
    // delete attempt that fails loudly rather than in a silent skip.
    const mine = projects.find((p) => p.name === PROJECT && p.deletedAt == null);
    if (mine?.id) await run("railway", ["delete", "--yes", "--project", mine.id]);
  } catch (error) {
    errors.push(error);
  }
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch((e: unknown) => errors.push(e));
  if (errors.length > 0) throw new AggregateError(errors, `teardown failed — check whether project ${PROJECT} lives`);
}, 300_000);

describe("deploy railway --run: a real project, provisioned and destroyed", () => {
  it("provisions, mints a domain, and serves a turn on it", async () => {
    let output: string;
    try {
      // flyctl's lesson: execFile's error carries the CLI's output but its message does not, and
      // "Command failed" is all an unattended nightly would otherwise report.
      const result = await run(process.execPath, [CLI, "deploy", "railway", "--run"], workspace);
      // BOTH streams: fastagent's own progress and result lines go to stderr (console.error), the
      // railway CLI's build log to stdout. The minted URL is on the former.
      output = result.stdout + result.stderr;
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string };
      throw new Error(`deploy railway --run failed for ${PROJECT}:\n${(e.stderr || e.stdout || "").slice(-4000)}`);
    }

    // Railway's URL is MINTED, not derived from the name the way Fly's is — the driver reports the
    // one it got back, so the probe reads it from there rather than constructing it.
    const url = output.match(/https:\/\/[a-z0-9-]+\.up\.railway\.app/i)?.[0];
    expect(url, `no minted domain in the deploy output:\n${output.slice(-1500)}`).toBeTruthy();

    expect(await waitForHealth(`${url}/health`, 180_000, 3_000), `${url}/health never came up`).toBe(true);

    const session = "live-railway";
    expect(
      (await invoke(url as string, session, "Remember this number: 47. Reply with just: ok")).at(-1),
    ).toMatchObject({
      type: "completed",
    });

    // Session continuity on the deployed service. Unlike the fly probe this does NOT restart first:
    // `railway redeploy` replaces the machine but the CLI offers no wait-for-ready, so a restart
    // here would race the next request rather than prove anything about the volume.
    const second = await invoke(
      url as string,
      session,
      "What number did I ask you to remember? Reply with digits only.",
    );
    expect(second.at(-1)).toMatchObject({ type: "completed" });
    expect(answerOf(second)).toContain("47");
  }, 900_000);
});
