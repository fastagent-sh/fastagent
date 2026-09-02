/**
 * What every live probe shares: the configuration rule, and the three platform-neutral moves a deploy
 * probe makes (drive the CLI, POST a turn, read the answer out of the stream).
 *
 * Live probes fail loudly on missing configuration instead of skipping: `npm run test:live` is an
 * explicit opt-in, so an unset variable is a broken run, not an absent capability. (A platform that
 * is genuinely DOWN is a different case — that belongs in the probe that talks to it.)
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { AgentEvent } from "../../src/agent.ts";
import { fastagentVersion } from "../../src/version.ts";
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`live probes need ${name} (${hint})`);
  return value;
}

/**
 * The published version under probe, read the same way by every probe: `FASTAGENT_LIVE_VERSION` when
 * it carries one — CI resolves the registry's current `latest` to an exact version ONCE and exports it
 * (.github/workflows/live.yml), so the registry install and the container image cannot report on two
 * artifacts — else this checkout's version, which is what a local run means.
 *
 * `||`, never `??`: an exported-but-empty variable is not a pin, and `??` would keep it. That installs
 * `@fastagent-sh/fastagent@` (npm resolves the empty range to `latest`) and then asserts the CLI
 * reports `""` — a probe that fails without ever naming the version it meant to check.
 */
export async function liveVersion(): Promise<string> {
  return process.env.FASTAGENT_LIVE_VERSION || (await fastagentVersion());
}

/** One spawned command. A container build's log is megabytes; execFile's 1 MB default would abort the
 *  deploy mid-flight. */
export const run = (file: string, args: string[], cwd?: string) =>
  promisify(execFile)(file, args, { ...(cwd ? { cwd } : {}), maxBuffer: 64 << 20 });

/** The product entry every deploy probe drives, spawned as `process.execPath [CLI, …]`. */
export const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** One `aws` invocation, returning the exit code instead of throwing on it. The AgentCore probes both
 *  need that: several assertions are ABOUT the failure (a name that does not exist must answer "not
 *  found", never "access denied"), and teardown must attempt every deletion even after one fails. */
export async function aws(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("aws", args);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** POST one turn to a deployed agent and return its SSE events (the built-in `/invoke`, mounted
 *  because no channel is declared). Same reduction test/http.test.ts uses; `JSON.parse` is
 *  deliberately unguarded, since a payload that is not an event is a broken wire format, not a case to
 *  absorb. */
export async function invoke(baseUrl: string, session: string, text: string): Promise<AgentEvent[]> {
  const response = await fetch(`${baseUrl}/invoke`, {
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
export const answerOf = (events: AgentEvent[]): string =>
  events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");
