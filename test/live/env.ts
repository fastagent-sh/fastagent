/**
 * What every live probe shares: the configuration rule, the platform-neutral moves a deploy probe
 * makes (drive the CLI, POST a turn, read the answer out of the stream), and the moves that only ONE
 * platform has but SEVERAL probes make — an `aws` call, AgentCore's teardown, the standing Railway
 * project. Those belong here for the reason the duplicated teardown proved: a second copy drifts, and
 * it drifts in cleanup code nobody reads until it has been leaking for weeks.
 *
 * Live probes fail loudly on missing configuration instead of skipping: `npm run test:live` is an
 * explicit opt-in, so an unset variable is a broken run, not an absent capability. (A platform that
 * is genuinely DOWN is a different case — that belongs in the probe that talks to it.)
 */
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { AgentEvent } from "../../src/agent.ts";
import { destroyAgentcoreDeployment as destroyDeployment } from "../../src/deploy/agentcore/destroy.ts";
import { ingressSessionId } from "../../src/deploy/agentcore/plan.ts";
import type { CliRunner } from "../../src/deploy/runner.ts";
import { fastagentVersion } from "../../src/version.ts";
import { TARBALL_ENV } from "./pack.ts";
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`live probes need ${name} (${hint})`);
  return value;
}

/**
 * The AWS credential a probe is about to spend tens of minutes on, asked the way the DRIVER asks it
 * (deploy/agentcore/run.ts): can the CLI authenticate, and is there a region — whatever supplies them.
 *
 * It replaced `requireEnv("AWS_ACCESS_KEY_ID"/"AWS_SECRET_ACCESS_KEY"/"AWS_REGION")`, which asked for
 * one FORM and picked the wrong one to insist on. CI's long-lived key satisfies it; a workstation runs
 * `aws login`, whose profile REFRESHES ITSELF (the driver and every `aws` call here use it happily) and
 * whose exported snapshot does not — 15 minutes, against a probe that needs 45. So the variables were
 * satisfiable here only in the form that cannot survive the probe.
 *
 * `minutes` is that window, and only a temporary credential has one to check: `AWS_CREDENTIAL_EXPIRATION`
 * rides along with an exported snapshot, and a long-lived key carries none. Checked BEFORE the deploy,
 * because expiry does not land where it happened — the first call to fail is somewhere past
 * `docker push`, it says `ExpiredToken` in the shape of a permissions problem, and it leaves a
 * half-created stack for a teardown whose credentials are equally dead.
 *
 * Returns the account id, which every AgentCore probe derives resource names from.
 */
export async function requireAwsAccount(minutes: number): Promise<string> {
  const deadline = process.env.AWS_CREDENTIAL_EXPIRATION;
  if (deadline) {
    const at = Date.parse(deadline);
    if (Number.isNaN(at)) throw new Error(`AWS_CREDENTIAL_EXPIRATION is not a date: ${deadline}`);
    const left = Math.round((at - Date.now()) / 60_000);
    if (left < minutes)
      throw new Error(
        `the exported AWS credentials expire in ${left} min and this probe needs ${minutes}. Re-export them, ` +
          `or unset AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN/AWS_CREDENTIAL_EXPIRATION and ` +
          `let the CLI profile refresh itself`,
      );
  }
  const identity = await aws(["sts", "get-caller-identity", "--output", "json"]);
  if (identity.code !== 0)
    throw new Error(
      `live probes need working AWS credentials (\`aws login\`, or AWS_ACCESS_KEY_ID/…): ${identity.stderr}`,
    );
  const account = (JSON.parse(identity.stdout) as { Account?: unknown }).Account;
  if (typeof account !== "string") throw new Error(`sts get-caller-identity returned no Account: ${identity.stdout}`);
  // The ECR registry hostname is built from it, so an unset region is a gate for the driver too.
  const region =
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    (await aws(["configure", "get", "region"])).stdout.trim();
  if (!region) throw new Error("live probes need an AWS region (AWS_REGION, or `aws configure set region <region>`)");
  return account;
}

/**
 * The published version `registry.live.test.ts` probes: `FASTAGENT_LIVE_VERSION` when CI pins one
 * (.github/workflows/live.yml resolves the registry's current `latest` to an exact version), else this
 * checkout's version.
 *
 * ITS ONLY CALLER IS THAT PROBE, because the registry is the only thing a version string can decide.
 * A deploy probe cannot be a release check whatever it installs: its CLI is `src/cli.ts`, its
 * CloudFormation comes from this checkout's plan and its forwarder from this checkout's
 * `forwarder.js`. Pinning only the dependency there does not produce "the release under test", it
 * produces a mixture — see {@link installSpec}.
 *
 * `||`, never `??`: an exported-but-empty variable is not a pin, and `??` would keep it. That installs
 * `@fastagent-sh/fastagent@` (npm resolves the empty range to `latest`) and then asserts the CLI
 * reports `""` — a probe that fails without ever naming the version it meant to check.
 */
export async function liveVersion(): Promise<string> {
  return process.env.FASTAGENT_LIVE_VERSION || (await fastagentVersion());
}

/**
 * What a deploy probe's fixture depends on: the tarball of THIS checkout, always.
 *
 * Every deploy probe used to write `dependencies: { "@fastagent-sh/fastagent": <version> }`, and npm resolved that
 * from the REGISTRY. The container then ran the last published release while the CLI, the generated template and
 * the forwarder all came from the working tree: the probe reported on a pair that exists nowhere, and could not
 * fail on a change to the code under review. A `POST /run` branch shipped a forwarder speaking a newer envelope
 * than the container it deployed, and the probe's only symptom was "EventBridge never delivered".
 *
 * ALWAYS, INCLUDING IN CI, because the mixture is not something a pin can fix. Three of the four artifacts a deploy
 * probe exercises come from the checkout unconditionally, so honouring `FASTAGENT_LIVE_VERSION` here would keep the
 * nightly run deploying "published container + this branch's forwarder" — the very pairing this function exists to
 * end, and one that would have turned `agentcore-wake` red every night after `POST /run` merged, at the cost of
 * two AgentCore deployments each time. Verifying a release means checking out its tag, not pinning one dependency.
 *
 * The tarball is built once per run by the `globalSetup` in vitest.live.config.ts; the image build carries `*.tgz`
 * into the install layer so a `file:` dependency survives it (deploy/container.ts).
 */
export async function installSpec(agentDir: string): Promise<string> {
  const tarball = process.env[TARBALL_ENV];
  if (!tarball) {
    throw new Error(
      `live probes need ${TARBALL_ENV} (set by the globalSetup in vitest.live.config.ts — run them with \`npm run test:live\`)`,
    );
  }
  await copyFile(tarball, join(agentDir, basename(tarball)));
  return `file:./${basename(tarball)}`;
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

/**
 * {@link aws} as the product's {@link CliRunner}. The two differ only in what they hand back: this one always
 * captures, since a probe has nowhere to stream to.
 */
const awsAsRunner: CliRunner = async (args) => {
  const { code, stdout, stderr } = await aws(args);
  return { code, stdout, stderr };
};

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
 * One invoke's TERMINAL, asserted with the event itself in the message.
 *
 * `toMatchObject({ type: "completed" })` was believed to print a `failed` terminal's `details` — it does not.
 * vitest diffs only the keys the matcher named and reports the rest as "(2 matching properties omitted from actual)",
 * so three nightlies went red with nothing in the log but `+ "type": "failed"`, and the reason each turn died was
 * discardable only by re-running a 20-minute probe against a platform that had already moved on.
 */
export function expectCompleted(events: AgentEvent[], what: string): void {
  const terminal = events.at(-1);
  expect(terminal?.type, `${what} did not complete: ${JSON.stringify(terminal)}`).toBe("completed");
}

/**
 * The ANSWER, and only it. Asserting on the raw SSE text would be wrong in both directions: a
 * provider that splits `47` into two tokens never spells it literally, and a `thinking` delta that
 * reasoned about the number would satisfy the assertion even when the answer got it wrong.
 */
export const answerOf = (events: AgentEvent[]): string =>
  events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");

/**
 * Everything one AgentCore probe created, torn down BY THE PRODUCT — `fastagent destroy agentcore --run`,
 * through the same function the CLI calls.
 *
 * This used to be the probe's own copy of the sequence, and the ordering in it is load-bearing in ways that are
 * invisible when they are wrong (wake alarms while the stack still stands, a bucket emptied before it is
 * deleted). A teardown only the probes owned is one that every non-probe deployment leaked past; the account
 * this repo is developed against grew five orphaned buckets that way. Calling the product means the teardown
 * path is exercised on every probe run instead of only by hand.
 */
export async function destroyAgentcoreDeployment(name: string): Promise<void> {
  const outcome = await destroyDeployment({ name, run: true }, awsAsRunner);
  if (!outcome.ok) throw new Error(`teardown failed: ${outcome.gate}`);
  // A KEPT resource is still billing. The product keeps a bucket holding anything but the forwarder's zips,
  // which for a probe means the deploy wrote something no version of it should have.
  if (outcome.kept.length > 0) throw new Error(`teardown kept resources: ${outcome.kept.join("; ")}`);
}

/**
 * One `invoke` envelope through a deployed AgentCore runtime, returning the raw stream body. There is
 * no public URL on this host — `POST /invocations` sits behind `InvokeAgentRuntime`, an IAM-signed AWS
 * API — so this is how every AgentCore probe asks the deployment to do something.
 *
 * `label` names two REAL FILES under `dir`, and the output one is why: this CLI writes the response
 * body to its positional argument, and on a runner whose stdout is a pipe Actions owns, `/dev/stdout`
 * answers "No such device or address".
 */
export async function invokeAgentcore(args: {
  runtimeArn: string;
  name: string;
  session: string;
  text: string;
  dir: string;
  label: string;
}): Promise<string> {
  const payload = join(args.dir, `${args.label}.json`);
  const out = join(args.dir, `${args.label}-reply.json`);
  await writeFile(payload, `${JSON.stringify({ kind: "invoke", session: args.session, text: args.text })}\n`);
  const reply = await aws([
    "bedrock-agentcore",
    "invoke-agent-runtime",
    "--agent-runtime-arn",
    args.runtimeArn,
    "--runtime-session-id",
    ingressSessionId(args.name),
    "--payload",
    `file://${payload}`,
    "--cli-binary-format",
    "raw-in-base64-out",
    out,
  ]);
  expect(reply.code, `invoke-agent-runtime (${args.label}) failed:\n${reply.stderr.slice(-2000)}`).toBe(0);
  return await readFile(out, "utf8");
}

/**
 * The long-lived Railway project both railway probes work inside, instead of each minting one.
 *
 * Two reasons beyond speed. A project per run left the account accumulating soft-deleted projects
 * (Railway deletes lazily, so they stay listed for days), and it kept the shape probe from being what
 * it claims to be: it had to CREATE a project to have one to read, purely because it needed something
 * linked. With a standing project it only links — read-only again, and to a project that is still its
 * own, which is the point the borrowed-production-project bug made the expensive way.
 *
 * The deploy probe adds a service inside it and removes that service; the project itself outlives
 * every run and belongs to no single one. It is created on first use, so a fresh account needs no
 * manual setup.
 */
export const RAILWAY_PROBE_PROJECT = "fastagent-live-probes";
