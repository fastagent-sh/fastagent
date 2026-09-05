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
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { AgentEvent } from "../../src/agent.ts";
import { ingressSessionId, stateBucketName } from "../../src/deploy/agentcore/plan.ts";
import { fastagentVersion } from "../../src/version.ts";
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

/**
 * Everything one AgentCore probe created, destroyed in the order the dependencies demand — ONE copy,
 * shared by every AgentCore probe, because each step is load-bearing in a way that is invisible when
 * it is wrong. What survives a silent teardown is a Bedrock runtime, a Lambda with a public Function
 * URL, an image in ECR and a bucket holding the model credential seed, all of them billing.
 *
 * WAKE ALARMS FIRST, while the stack still stands. The forwarder creates them at RUNTIME with the SDK
 * into the `default` Scheduler group, so they are not stack resources and `delete-stack` does not take
 * them; `ActionAfterCompletion: DELETE` only runs once a schedule FIRES, so anything killed between
 * the wake call and the fire leaves one pending. After `delete-stack` its target is gone and it
 * retries into nothing for weeks — the orphan shape this account actually grew. Swept for EVERY
 * fixture, not only the one that asks for wake-ups: one line (`selfSchedule`, a channel, a schedule)
 * turns the forwarder on, and a teardown that had to be extended first would leak before it was.
 *
 * THE BUCKET IS VERSIONED (run.ts enables it), so `s3 rm` does not empty it — it writes a DELETE
 * MARKER per object, and a marker comes back under DeleteMarkers, not Versions. Deleting only Versions
 * leaves the bucket non-empty and `delete-bucket` answers BucketNotEmpty. Both lists, or it leaks.
 *
 * The bucket and the repository are created OUTSIDE the stack on purpose (plan.ts: so a `delete-stack`
 * "cannot take the agent's memory with it") — correct for an operator, which makes them a probe's own
 * job. Every deletion is ATTEMPTED even after an earlier one fails, and every failure is collected
 * into one throw: "already gone" is the goal state, not a failure.
 */
export async function destroyAgentcoreDeployment(name: string, account: string): Promise<void> {
  const stack = `fastagent-${name}`;
  const repo = `fastagent/${name}`;
  const errors: unknown[] = [];
  const attempt = async (label: string, args: string[]) => {
    const { code, stderr } = await aws(args);
    if (code !== 0 && !/does not exist|NotFound|NoSuchBucket/i.test(stderr)) {
      errors.push(new Error(`${label} failed: ${stderr.slice(0, 500)}`));
    }
  };

  // The forwarder names every alarm `WAKE_PREFIX + sha256(wakeId)[:16]` (plan.ts). The prefix is all a
  // probe can predict — the id is minted inside the container.
  const alarmPrefix = `fa-${name}-wk-`;
  const pending = await aws(["scheduler", "list-schedules", "--name-prefix", alarmPrefix, "--output", "json"]);
  if (pending.code === 0) {
    for (const alarm of (JSON.parse(pending.stdout) as { Schedules?: { Name: string }[] }).Schedules ?? []) {
      await attempt(`scheduler delete-schedule ${alarm.Name}`, ["scheduler", "delete-schedule", "--name", alarm.Name]);
    }
  } else {
    // Not fatal to the rest of teardown, but never silent: an unreadable list is indistinguishable from
    // an empty one, and the difference is whether something is still out there firing.
    errors.push(new Error(`could not list wake alarms under ${alarmPrefix}: ${pending.stderr.slice(0, 300)}`));
  }

  await attempt("delete-stack", ["cloudformation", "delete-stack", "--stack-name", stack]);
  await attempt("wait stack-delete-complete", [
    "cloudformation",
    "wait",
    "stack-delete-complete",
    "--stack-name",
    stack,
  ]);
  if (account) {
    const bucket = stateBucketName(name, account);
    await attempt("s3 rm", ["s3", "rm", `s3://${bucket}`, "--recursive"]);
    const listed = await aws(["s3api", "list-object-versions", "--bucket", bucket, "--output", "json"]);
    if (listed.code === 0) {
      const payload = JSON.parse(listed.stdout) as {
        Versions?: { Key: string; VersionId: string }[];
        DeleteMarkers?: { Key: string; VersionId: string }[];
      };
      const objects = [...(payload.Versions ?? []), ...(payload.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({
        Key,
        VersionId,
      }));
      if (objects.length > 0) {
        const del = JSON.stringify({ Objects: objects });
        await attempt("s3api delete-objects", ["s3api", "delete-objects", "--bucket", bucket, "--delete", del]);
      }
    }
    await attempt("s3 rb", ["s3api", "delete-bucket", "--bucket", bucket]);
  }
  await attempt("ecr delete-repository", ["ecr", "delete-repository", "--repository-name", repo, "--force"]);

  if (errors.length > 0) {
    throw new AggregateError(errors, `teardown failed — check stack ${stack}, bucket fa-${name}-*, repo ${repo}`);
  }
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
