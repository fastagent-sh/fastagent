/**
 * A definition on disk → a real container serving real turns, driven through the CLI a user runs.
 * This is the probe for everything the offline deploy tests fake at the `CliRunner` seam: the
 * generated Dockerfile actually builds, the image boots, the credential carry arrives, `/health` and
 * `POST /invoke` answer, and the state volume outlives the container.
 *
 * Needs a model credential the way the product needs one: a provider env key in the environment, or
 * `FASTAGENT_AUTH_PATH` pointing at a stored auth.json. Without either, `--run` gates before it
 * builds and this test fails with that gate's own message.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent.ts";
import { waitForHealth } from "../../src/channels/wait-health.ts";
import { exists } from "../../src/paths.ts";
import { liveVersion, requireEnv } from "./env.ts";

// A container build's log is megabytes; execFile's 1 MB default would abort the deploy mid-build.
const run = (file: string, args: string[], cwd: string) =>
  promisify(execFile)(file, args, { cwd, maxBuffer: 64 << 20 });
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const MODEL = requireEnv("FASTAGENT_LIVE_MODEL", 'the model under test, e.g. "anthropic/claude-sonnet-4-5"');
const VERSION = await liveVersion();
const COMPOSE = "fastagent/fastagent.compose.yml";

let workspace = "";
let port = 0;

/** An ephemeral port for the container to publish on 127.0.0.1: taken to learn a free number, then
 *  released — nothing holds it until the container binds it. What keeps concurrent runs apart is
 *  `fileParallelism: false` plus the per-run Compose project name; losing the race in between surfaces
 *  as `docker compose up` failing to bind, never as two probes on one port. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: taken } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return taken;
}

const compose = (args: string[]) => run("docker", ["compose", "-f", COMPOSE, ...args], workspace);

beforeAll(async () => {
  port = await freePort();
  workspace = await mkdtemp(join(tmpdir(), "fa-live-docker-"));
  const agent = join(workspace, "fastagent");
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "persona.md"), "You are terse. Answer in as few words as possible.\n");
  await writeFile(
    join(agent, "fastagent.config.mjs"),
    `export default { model: ${JSON.stringify(MODEL)}, http: { port: ${port} } };\n`,
  );
  // The agent declares the fastagent version it runs, so the image installs the SAME artifact the
  // registry probe does. Without this the generated Dockerfile takes the markdown-agent path and
  // bakes `npm i -g @fastagent-sh/fastagent@<this checkout>` (src/deploy/container.ts), which no
  // environment variable can redirect: a dispatch pinning FASTAGENT_LIVE_VERSION would then move the
  // registry probe alone, and the two would report on two different artifacts.
  await writeFile(
    join(agent, "package.json"),
    `${JSON.stringify(
      { name: "live-docker-probe", private: true, dependencies: { "@fastagent-sh/fastagent": VERSION } },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  // Tear down whatever the deploy created, volume included: a leaked probe deployment is a leaked
  // model credential. The one expected failure — `down` when the deploy never got as far as writing a
  // Compose file — is ruled out by asking whether that file exists, so nothing here needs absorbing:
  // a `down` that fails now is a daemon refusing to remove a container that holds CI's credential,
  // and a run that ends green while that container keeps running is the outcome worth failing over.
  // `--rmi local`: the Compose project name carries this run's mkdtemp suffix, so the built image is
  // unique per run and nothing else can reuse it. Without this every local `npm run test:live` leaves
  // another node:22-slim + full pi dependency tree behind.
  if (workspace && (await exists(join(workspace, COMPOSE)))) await compose(["down", "-v", "--rmi", "local"]);
  if (workspace) await rm(workspace, { recursive: true });
});

/** POST one turn and return its SSE events (the built-in `/invoke`, mounted because no channel is
 *  declared). Same reduction test/http.test.ts uses; `JSON.parse` is deliberately unguarded, since a
 *  payload that is not an event is a broken wire format, not a case to absorb. */
async function invoke(session: string, text: string): Promise<AgentEvent[]> {
  const response = await fetch(`http://127.0.0.1:${port}/invoke`, {
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

/**
 * The ANSWER, and only it. Asserting on the raw SSE text would be wrong in both directions: a
 * provider that splits `47` into two tokens never spells it literally, and a `thinking` delta that
 * reasoned about the number would satisfy the assertion even when the answer got it wrong.
 */
const answerOf = (events: AgentEvent[]): string =>
  events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");

describe("deploy docker --run: a definition serving real turns in a container", () => {
  it("builds, boots, answers, and keeps its sessions across a restart", async () => {
    // Every gate in the driver exits non-zero, so a refusal surfaces here as this call's rejection,
    // carrying the gate's own remediation text.
    await run(process.execPath, [CLI, "deploy", "docker", "--run"], workspace);

    expect(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text())).toBe("ok\n");

    const session = "live-docker";
    // toMatchObject, not `.at(-1)?.type`: a `failed` terminal carries `details`/`retryable` (SPEC
    // MUST 2), and a mismatch prints the whole event. Nobody is watching a nightly run, so a bare
    // `expected 'failed' to be 'completed'` costs a full re-run to learn why.
    expect((await invoke(session, "Remember this number: 47. Reply with just: ok")).at(-1)).toMatchObject({
      type: "completed",
    });

    // The state volume is the deployment's continuity. Restarting the container drops every bit of
    // in-process state, so what answers afterwards can only have come off the volume.
    await compose(["restart", "agent"]);
    expect(await waitForHealth(`http://127.0.0.1:${port}/health`, 60_000, 500)).toBe(true);
    const listed = await compose(["exec", "-T", "agent", "ls", "/data/.state/sessions"]);
    expect(listed.stdout.trim()).not.toBe("");

    const second = await invoke(session, "What number did I ask you to remember? Reply with digits only.");
    expect(second.at(-1)).toMatchObject({ type: "completed" });
    expect(answerOf(second)).toContain("47");
  });
});
