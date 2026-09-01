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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForHealth } from "../../src/channels/wait-health.ts";
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

/** A port the container will publish on 127.0.0.1 — taken and released, so parallel runs do not collide. */
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
  // Always tear down, including the volume: a leaked probe deployment is a leaked model credential.
  // Swallowed on purpose — `down` also runs when the deploy never got as far as writing a Compose
  // file, and rethrowing from a hook would replace the real test failure with this one. REPORTED on
  // purpose too: the case this catch exists to absorb looks identical to a daemon that refused to
  // remove a running container, and that one leaves CI's credential live in it.
  if (workspace) await compose(["down", "-v"]).catch((error) => console.error(`[live] teardown failed: ${error}`));
});

/** POST one turn and return the SSE body (the built-in `/invoke`, mounted because no channel is declared). */
async function invoke(session: string, text: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text }),
  });
  expect(response.status).toBe(200);
  return await response.text();
}

describe("deploy docker --run: a definition serving real turns in a container", () => {
  it("builds, boots, answers, and keeps its sessions across a restart", async () => {
    // Every gate in the driver exits non-zero, so a refusal surfaces here as this call's rejection,
    // carrying the gate's own remediation text.
    await run(process.execPath, [CLI, "deploy", "docker", "--run"], workspace);

    expect(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text())).toBe("ok\n");

    const session = "live-docker";
    expect(await invoke(session, "Remember this number: 47. Reply with just: ok")).toContain('"type":"completed"');

    // The state volume is the deployment's continuity. Restarting the container drops every bit of
    // in-process state, so what answers afterwards can only have come off the volume.
    await compose(["restart", "agent"]);
    expect(await waitForHealth(`http://127.0.0.1:${port}/health`, 60_000, 500)).toBe(true);
    const listed = await compose(["exec", "-T", "agent", "ls", "/data/.state/sessions"]);
    expect(listed.stdout.trim()).not.toBe("");

    const second = await invoke(session, "What number did I ask you to remember? Reply with digits only.");
    expect(second).toContain('"type":"completed"');
    expect(second).toContain("47");
  });
});
