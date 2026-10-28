/**
 * What every live probe shares: the configuration rule, the platform-neutral moves a deploy probe
 * makes (drive the CLI, ask the deployed agent through its probe channel, read how the message ended), and the moves
 * that only ONE
 * platform has but SEVERAL probes make — an `aws` call, AgentCore's teardown, the standing Railway
 * project. Those belong here for the reason the duplicated teardown proved: a second copy drifts, and
 * it drifts in cleanup code nobody reads until it has been leaking for weeks.
 *
 * Live probes fail loudly on missing configuration instead of skipping: `npm run test:live` is an
 * explicit opt-in, so an unset variable is a broken run, not an absent capability. (A platform that
 * is genuinely DOWN is a different case — that belongs in the probe that talks to it.)
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { destroyAgentcoreDeployment as destroyDeployment } from "../../src/deploy/agentcore/destroy.ts";
import { PROBE_PAYLOAD, ingressSessionId } from "../../src/deploy/agentcore/plan.ts";
import type { CliRunner } from "../../src/deploy/runner.ts";
import type { Message } from "../../src/agent-api.ts";
import { dotEnvPath } from "../../src/env.ts";
import { environmentAuth } from "../../src/harnesses/models/models.ts";
import { openServing } from "../../src/harnesses/pi-durable/serve.ts";
import { type ServedAgent, serveAgent } from "../../src/service.ts";
import { fastagentVersion } from "../../src/version.ts";
import { TARBALL_ENV } from "./pack.ts";
/** The agent in `dir`, opened and served as `start` does it (with no storage of its own): what a probe listens on. */
export async function serveDirectory(dir: string): Promise<{ service: ServedAgent; close(): Promise<void> }> {
  const opened = await openServing(dir, { storage: "memory" });
  const service = await serveAgent(opened);
  return {
    service,
    close: async () => {
      await service.close();
      await opened.agent.close();
    },
  };
}

/** The value file a deploy reads: the deployed environment (src/deploy/secrets.ts). */
const productionEnv = (agentDir: string) => dotEnvPath(agentDir, { FASTAGENT_ENVIRONMENT: "production" });

export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`live probes need ${name} (${hint})`);
  return value;
}

/**
 * A deploy probe's model credential, carried the way a deployment carries one: the provider's API key, from THIS
 * environment into the agent's production value file, which `deploy --run` sends to the host. A stored login does not
 * travel (the box logs in itself, which needs a person at a browser), so an unattended probe can only deploy a model
 * that authenticates with a key. Which variable is the provider's own is pi's answer, the one the box will ask.
 */
export async function stageModelKey(agentDir: string, model: string): Promise<void> {
  const provider = model.slice(0, model.indexOf("/"));
  const name = (await environmentAuth(provider, process.env))?.source;
  const value = name === undefined ? undefined : process.env[name];
  if (name === undefined || !/^[A-Z][A-Z0-9_]*$/.test(name) || !value) {
    throw new Error(
      `deploy probes need ${model}'s API key in the environment (its provider's own variable, e.g. OPENAI_API_KEY): ` +
        `it travels through .secrets/production/.env, and a login on the box would need a person`,
    );
  }
  await mkdir(dirname(productionEnv(agentDir)), { recursive: true });
  await writeFile(productionEnv(agentDir), `${name}=${value}\n`, { mode: 0o600 });
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
 * fail on a change to the code under review. One branch shipped a forwarder speaking a newer envelope
 * than the container it deployed, and the probe's only symptom was "EventBridge never delivered".
 *
 * ALWAYS, INCLUDING IN CI, because the mixture is not something a pin can fix. Three of the four artifacts a deploy
 * probe exercises come from the checkout unconditionally, so honouring `FASTAGENT_LIVE_VERSION` here would keep the
 * nightly run deploying "published container + this branch's forwarder" — the very pairing this function exists to
 * end, and one that would have turned `agentcore-wake` red every night after that branch merged, at the cost of
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

/**
 * `deploy agentcore --run` from `agentDir`, the way every AgentCore probe drives it. On failure the error
 * carries CloudFormation's own per-resource reasons, read HERE because the probe's teardown deletes the stack
 * next — and with it the only place a nightly could have read why. The driver's own message names the
 * command to run; an unattended run has nobody to run it before the stack is gone.
 */
export async function deployAgentcore(agentDir: string, stack: string): Promise<void> {
  try {
    await run(process.execPath, [CLI, "deploy", "agentcore", "--run"], agentDir);
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    const events = await aws([
      "cloudformation",
      "describe-stack-events",
      "--stack-name",
      stack,
      "--query",
      "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatus, ResourceStatusReason]",
      "--output",
      "text",
    ]);
    const reasons =
      events.code === 0
        ? events.stdout.trim() || "(no FAILED events — the failure was before CloudFormation)"
        : `(could not read the stack events: ${events.stderr.trim().slice(0, 300)})`;
    throw new Error(
      `deploy agentcore --run failed for ${stack}:\n${(e.stderr || e.stdout || "").slice(-4000)}\n` +
        `CloudFormation's FAILED events:\n${reasons.slice(0, 4000)}`,
    );
  }
}

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
 * {@link aws} as the product's {@link CliRunner}. A probe has nowhere to stream to, so this one always captures
 * — but it honours `captureStderr`, because a caller that did not ask for stderr must not receive it: that is
 * the flag `aws-cli.ts` classifies through, and a double that ignores it cannot fail when the product does.
 */
export const awsAsRunner: CliRunner = async (args, opts) => {
  const { code, stdout, stderr } = await aws(args);
  return { code, stdout, stderr: opts?.captureStderr ? stderr : undefined };
};

/** The variable the probe channel checks its caller against; it travels to the host in the value file. */
const PROBE_SECRET = "FASTAGENT_PROBE_SECRET";

/**
 * The channel a deploy probe adds to its fixture, because a deployed agent is reached only through its channels:
 * `POST /probe/ask` with the probe's secret sends one message, in the session the body names or a new one, and
 * answers with the session and how the message ended. A fixture's channel, so it verifies its caller as every
 * channel must.
 */
const PROBE_CHANNEL = `import { needs } from "@fastagent-sh/fastagent";

export default needs(["${PROBE_SECRET}"], (secrets) => ({ agent }) => ({
  "POST /probe/ask": async (request) => {
    if (request.headers.get("authorization") !== \`Bearer \${secrets.${PROBE_SECRET}}\`) {
      return new Response("", { status: 401 });
    }
    const asked = await request.json();
    const sessionId = asked.sessionId ?? (await agent.sessions.create()).id;
    const message = await agent.messages.send({ sessionId, content: asked.text }, { wait: 600 });
    return Response.json({ sessionId, message });
  },
}));
`;

/** Add the probe channel to `agentDir` and its secret to the value file (after {@link stageModelKey}); returns it. */
export async function stageProbeChannel(agentDir: string): Promise<string> {
  const secret = randomBytes(24).toString("hex");
  await mkdir(join(agentDir, "src", "channels"), { recursive: true });
  await writeFile(join(agentDir, "src", "channels", "probe.ts"), PROBE_CHANNEL);
  await mkdir(dirname(productionEnv(agentDir)), { recursive: true });
  await appendFile(productionEnv(agentDir), `${PROBE_SECRET}=${secret}\n`, { mode: 0o600 });
  return secret;
}

/** One message to a deployed agent through its probe channel: the session it went to, and how it ended. */
export interface Asked {
  sessionId: string;
  message: Message;
}

/** Ask the agent served at `baseUrl` (or relayed to it) one thing, in `sessionId` or a new session. */
export async function ask(baseUrl: string, secret: string, text: string, sessionId?: string): Promise<Asked> {
  const response = await fetch(`${baseUrl}/probe/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ text, ...(sessionId === undefined ? {} : { sessionId }) }),
  });
  const body = await response.text();
  expect(response.status, `the probe channel answered ${response.status}: ${body.slice(0, 2000)}`).toBe(200);
  return JSON.parse(body) as Asked;
}

/**
 * One message's end, asserted with the end itself in the message.
 *
 * A partial matcher was believed to print a failure's details; it does not. vitest diffs only the keys the matcher
 * named, so three nightlies went red with nothing in the log but the status, and the reason each run died was
 * discoverable only by re-running a 20-minute probe against a platform that had already moved on.
 */
export function expectCompleted(asked: Asked, what: string): void {
  expect(asked.message.status, `${what} did not complete: ${JSON.stringify(asked.message)}`).toBe("completed");
}

/**
 * The ANSWER, and only it. Asserting on anything wider would be wrong in both directions: a provider that splits
 * `47` into two tokens never spells it literally, and a `thinking` delta that reasoned about the number would satisfy
 * the assertion even when the answer got it wrong.
 */
export const answerOf = (asked: Asked): string => asked.message.answer?.text ?? "";

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
 * The probe envelope through a deployed AgentCore runtime: the IAM door's one kind, which opens the agent and says
 * whether it opened. There is no public URL on this host for it — `POST /invocations` sits behind
 * `InvokeAgentRuntime`, an IAM-signed AWS API.
 *
 * `label` names two REAL FILES under `dir`, and the output one is why: this CLI writes the response body to its
 * positional argument, and on a runner whose stdout is a pipe Actions owns, `/dev/stdout` answers "No such device or
 * address".
 */
export async function probeAgentcore(args: { runtimeArn: string; name: string; dir: string; label: string }) {
  const payload = join(args.dir, `${args.label}.json`);
  const out = join(args.dir, `${args.label}-reply.json`);
  await writeFile(payload, `${PROBE_PAYLOAD}\n`);
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
  return JSON.parse(await readFile(out, "utf8")) as { ok: boolean; error?: string };
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
