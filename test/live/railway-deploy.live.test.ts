/**
 * A real Railway deployment, created and destroyed: `deploy railway --run` sets variables, provisions
 * a volume, builds, deploys, and mints a public domain.
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
 * IT DEPLOYS WITH `--into-linked`, into a service it creates inside {@link RAILWAY_PROBE_PROJECT}. That
 * is the flag's own path — the driver SKIPS `init` and `add --service` and expects both to exist — and
 * it had no coverage while every run minted a throwaway project instead. The standing project also
 * stops the account filling with soft-deleted ones: Railway deletes lazily, so a project per run stays
 * listed for days.
 *
 * COSTS REAL RESOURCES. Teardown removes the SERVICE, never the project: the project outlives every
 * run and belongs to no single one, and the shape probe links it too.
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
import { CLI, RAILWAY_PROBE_PROJECT, answerOf, invoke, liveVersion, requireEnv, run } from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("RAILWAY_API_TOKEN", "an ACCOUNT-scoped Railway token — this probe creates and destroys a project");

/** The SERVICE this run owns inside the standing project. Derived through the product's own slug rule
 *  (deploy.ts: `toRailwayName(basename(workspace))`), so the name torn down is the one deployed into.
 *  Per-run uuid: concurrent runs share the project and must not collide. */
const SERVICE = toRailwayName(`fastagent-live-${randomUUID().slice(0, 8)}`);

let workspace = "";
/** Gates teardown: a `service delete` for a service that was never added reports a confusing failure
 *  and hides whichever real error stopped the run before it. */
let serviceCreated = false;

beforeAll(async () => {
  workspace = join(tmpdir(), SERVICE);
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

  // What `--into-linked` REQUIRES and does not create: the driver skips `init` and `add --service` on
  // that flag, so both have to exist before it runs. `add --service` creates AND links the service
  // (run.ts says so where it calls the same command), which is what makes the deploy land here.
  const linked = await run(
    "railway",
    ["link", "--project", RAILWAY_PROBE_PROJECT, "--environment", "production"],
    workspace,
  );
  if (linked.stderr.includes("error")) throw new Error(`could not link ${RAILWAY_PROBE_PROJECT}: ${linked.stderr}`);
  await run("railway", ["add", "--service", SERVICE], workspace);
  serviceCreated = true;
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    // The SERVICE, not the project: `service delete` runs against the linked directory, which is the
    // workspace the deploy linked. What leaks if this is skipped is a service holding the model
    // credential and serving `/invoke` unauthenticated — same stake as the project delete it replaces,
    // one level down.
    if (serviceCreated) await run("railway", ["service", "delete", "--service", SERVICE, "--yes"], workspace);
  } catch (error) {
    errors.push(error);
  }
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch((e: unknown) => errors.push(e));
  if (errors.length > 0)
    throw new AggregateError(errors, `teardown failed — check for service ${SERVICE} in ${RAILWAY_PROBE_PROJECT}`);
}, 300_000);

describe("deploy railway --run: a real project, provisioned and destroyed", () => {
  it("provisions, mints a domain, and serves a turn on it", async () => {
    let output: string;
    try {
      // flyctl's lesson: execFile's error carries the CLI's output but its message does not, and
      // "Command failed" is all an unattended nightly would otherwise report.
      const result = await run(process.execPath, [CLI, "deploy", "railway", "--run", "--into-linked"], workspace);
      // BOTH streams: fastagent's own progress and result lines go to stderr (console.error), the
      // railway CLI's build log to stdout. The minted URL is on the former.
      output = result.stdout + result.stderr;
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string };
      throw new Error(`deploy railway --run failed for ${SERVICE}:\n${(e.stderr || e.stdout || "").slice(-4000)}`);
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
