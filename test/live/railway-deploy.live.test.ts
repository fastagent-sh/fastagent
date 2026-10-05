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
import {
  CLI,
  RAILWAY_PROBE_PROJECT,
  answerOf,
  expectCompleted,
  invoke,
  installSpec,
  requireEnv,
  run,
  stageModelKey,
} from "./env.ts";

const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
requireEnv("RAILWAY_API_TOKEN", "an ACCOUNT-scoped Railway token — this probe creates and destroys a project");

/** The SERVICE this run owns inside the standing project. Derived through the product's own slug rule
 *  (deploy.ts: `toRailwayName(basename(agentDir))`), so the name torn down is the one deployed into.
 *  Per-run uuid: concurrent runs share the project and must not collide. */
const SERVICE = toRailwayName(`fastagent-live-${randomUUID().slice(0, 8)}`);

let agentDir = "";
/** Gates teardown: a `service delete` for a service that was never added reports a confusing failure
 *  and hides whichever real error stopped the run before it. */
let serviceCreated = false;

beforeAll(async () => {
  agentDir = join(tmpdir(), SERVICE);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "SYSTEM.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(join(agentDir, "fastagent.config.ts"), `export default { model: ${JSON.stringify(MODEL)} };\n`);
  await stageModelKey(agentDir, MODEL);
  await writeFile(
    join(agentDir, "package.json"),
    `${JSON.stringify(
      {
        name: "live-railway-probe",
        private: true,
        dependencies: { "@fastagent-sh/fastagent": await installSpec(agentDir) },
      },
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
    agentDir,
  );
  if (linked.stderr.includes("error")) throw new Error(`could not link ${RAILWAY_PROBE_PROJECT}: ${linked.stderr}`);
  await run("railway", ["add", "--service", SERVICE], agentDir);
  serviceCreated = true;
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    // The SERVICE, not the project: `service delete` runs against the linked directory, which is the
    // agent directory the deploy linked. What leaks if this is skipped is a service holding the model
    // credential and serving `/invoke` unauthenticated — same stake as the project delete it replaces,
    // one level down.
    if (serviceCreated) {
      // Deleting a service KEEPS its volume, so read the volume's id first and remove it after: otherwise every
      // run leaves a 50 GB volume billing in the standing project.
      const listed = await run("railway", ["volume", "list", "--json"], agentDir);
      const ours = (JSON.parse(listed.stdout) as { volumes: { id: string; serviceName: string | null }[] }).volumes
        .filter((volume) => volume.serviceName === SERVICE)
        .map((volume) => volume.id);
      await run("railway", ["service", "delete", "--service", SERVICE, "--yes"], agentDir);
      for (const id of ours) await run("railway", ["volume", "delete", "--volume", id, "--yes"], agentDir);
    }
  } catch (error) {
    errors.push(error);
  }
  if (agentDir) await rm(agentDir, { recursive: true, force: true }).catch((e: unknown) => errors.push(e));
  if (errors.length > 0)
    throw new AggregateError(errors, `teardown failed — check for service ${SERVICE} in ${RAILWAY_PROBE_PROJECT}`);
}, 300_000);

/** The service's latest deployment log, as text — never a throw: this is read only to explain a failure. */
async function deploymentLog(service: string, cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(
      "railway",
      ["logs", "--deployment", "--lines", "200", "--service", service],
      cwd,
    );
    return (stdout || stderr).slice(-8000) || "(empty)";
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return `(could not read the deployment log: ${(e.stderr || e.message || "").slice(0, 300)})`;
  }
}

describe("deploy railway --run: a real project, provisioned and destroyed", () => {
  it("provisions, mints a domain, and serves a turn on it", async () => {
    let output: string;
    try {
      // flyctl's lesson: execFile's error carries the CLI's output but its message does not, and
      // "Command failed" is all an unattended nightly would otherwise report.
      const result = await run(process.execPath, [CLI, "deploy", "railway", "--run", "--into-linked"], agentDir);
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

    // WHY it never came up is in the deployment's own log, and teardown deletes the service — and the log with
    // it — right after this assertion. Read it first, so an unattended run reports the cause, not the symptom.
    const healthy = await waitForHealth(`${url}/health`, 180_000, 3_000);
    const why = healthy ? "" : await deploymentLog(SERVICE, agentDir);
    expect(healthy, `${url}/health never came up. The deployment's log (last 200 lines):\n${why}`).toBe(true);

    const session = "live-railway";
    expectCompleted(
      await invoke(url as string, session, "Remember this number: 47. Reply with just: ok"),
      "the first turn",
    );

    // Session continuity on the deployed service. Unlike the fly probe this does NOT restart first:
    // `railway redeploy` replaces the machine but the CLI offers no wait-for-ready, so a restart
    // here would race the next request rather than prove anything about the volume.
    const second = await invoke(
      url as string,
      session,
      "What number did I ask you to remember? Reply with digits only.",
    );
    expectCompleted(second, "the second turn");
    expect(answerOf(second)).toContain("47");
  }, 900_000);
});
