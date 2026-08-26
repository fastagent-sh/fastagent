/**
 * `fastagent deploy agentcore --run` — drive the AWS CLI + Docker to completion. The middle of the
 * deploy the plain runbook hands to the operator; `--run` executes it so a coding agent runs ONE
 * command. Idempotent (ECR check-then-act; `cloudformation deploy` converges the stack) and
 * resumable: it STOPS at a human gate with one actionable line and a non-zero exit.
 *
 * TWO runners, one seam ({@link CliRunner}): `aws` (identity, ECR, CloudFormation) and `docker`
 * (buildx). AgentCore is the ONE host whose image builds on the operator's machine — the platform
 * requires linux/arm64 in the account's ECR and has no remote builder — so a missing Docker/buildx
 * is a first-class gate, not an incidental failure.
 *
 * Secrets ride CloudFormation NoEcho parameters. `--parameter-overrides` on argv would put the
 * values in the process listing (the same reason Fly imports secrets over stdin), so they go through
 * a caller-provided temp parameters file (`file://…`, mode 0600, deleted by the caller) — the write
 * is injected to keep this module pure and the security-sensitive wiring testable.
 */
import type { RegistrationOutcome } from "../../channels/registration.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { registrationGate } from "../registration-gate.ts";
import type { CliRunner } from "../runner.ts";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  AUTH_SEED_CHUNK_SIZE,
  AUTH_SEED_MAX_CHUNKS,
  cfnParamName,
  forwarderSource,
  ingressSessionId,
  stateBucketName,
} from "./plan.ts";
import { zipSingleFile } from "./zip.ts";

export interface AgentcoreRunPlan {
  /** The base name — stack `fastagent-<name>`, ECR repo `fastagent/<name>`. */
  name: string;
  /** Template path relative to the run cwd (kit layout: `agent/agentcore.template.yaml`). */
  templatePath: string;
  /** Dockerfile path for `-f` (kit layout only; the default context Dockerfile otherwise). */
  dockerfilePath?: string;
  /** Image tag for this deploy — the CALLER mints it unique (a timestamp): CloudFormation only rolls
   *  the runtime when the ImageUri value changes, so a reused tag would deploy nothing. */
  tag: string;
  /** AWS region from the caller's environment (AWS_REGION/AWS_DEFAULT_REGION), else resolved via
   *  `aws configure get region` — an unset region is a gate (the ECR registry hostname needs it). */
  region?: string;
  /** Secret env-var name → value (model key or FASTAGENT_AUTH_SEED + channel secrets). Mapped to the
   *  template's parameter names via {@link cfnParamName}; delivered via the params file, never argv. */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — gated before any side effect. */
  missingSecrets: string[];
  channels: ChannelKind[];
  /** Whether the topology includes the forwarder Lambda (route channels / schedules / selfSchedule).
   *  It owns the state snapshot's presigned URLs, so its absence means an invoke-only deployment
   *  with no cross-deploy state to keep. */
  needsForwarder: boolean;
}

export type AgentcoreRunOutcome = { ok: true; runtimeArn: string; url?: string } | { ok: false; gate: string };

/** How long the post-deploy probe waits for the fresh session (image pull + microVM boot + snapshot
 *  restore + channel construction) before gating with the last answer. */
const PROBE_TIMEOUT_MS = 120_000;
const PROBE_INTERVAL_MS = 3_000;

/**
 * Drive the forwarder's reserved `/__fastagent/probe` path until it answers, and read the runtime's
 * STRUCTURED verdict. The path answers on every forwarder topology (a schedule-only URL refuses
 * ordinary public traffic, so a plain `GET /health` would 404 there), and the verdict rides a
 * transport-200 JSON body `{ ok, error? }` — the ordinary webhook relay folds a non-200 transport
 * into an opaque 502, which would strip the very diagnostics this probe exists to carry.
 *
 * Outcome policy: `ok:true` verifies the deploy; `ok:false` gates IMMEDIATELY with the runtime's own
 * error text (construction rejections are cached per session, so polling cannot change the answer);
 * anything else (unroutable URL, forwarder 4xx/5xx, malformed body) is retried to the deadline —
 * that budget's job is absorbing cold-start provisioning — and then gates with the last answer seen.
 */
async function probeRuntime(
  probeUrl: string,
  auth: string,
  fetchImpl: typeof fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  intervalMs = PROBE_INTERVAL_MS,
): Promise<{ ok: true } | { ok: false; gate: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    try {
      const res = await fetchImpl(probeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth }),
        signal: AbortSignal.timeout(65_000),
      });
      const bodyText = await res.text();
      if (res.status === 200) {
        let verdict: { ok?: unknown; error?: unknown } | undefined;
        try {
          verdict = JSON.parse(bodyText) as { ok?: unknown; error?: unknown };
        } catch {
          /* malformed — fall through to retry with it as the last answer */
        }
        if (verdict?.ok === true) return { ok: true };
        if (verdict?.ok === false) {
          const error = typeof verdict.error === "string" ? verdict.error : "unknown error";
          return { ok: false, gate: `the deployed runtime failed its probe: ${error} — fix and re-run` };
        }
      }
      const firstLine = bodyText.trim().split("\n")[0] ?? "";
      last = `${res.status}${firstLine ? ` ${firstLine}` : ""}`;
    } catch {
      /* not routable yet (Function URL DNS, cold start) — keep polling until the deadline */
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        gate: last
          ? `the forwarder probe never verified the deployment (last answer: ${last}) — check the runtime logs and re-run`
          : "the forwarder URL never answered the probe — check the Function URL / runtime logs and re-run",
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Stack outputs (`describe-stacks --query "Stacks[0].Outputs"`) → { OutputKey: OutputValue }. */
export function parseStackOutputs(stdout: string): Record<string, string> {
  try {
    const arr = JSON.parse(stdout) as { OutputKey?: unknown; OutputValue?: unknown }[];
    if (!Array.isArray(arr)) return {};
    const out: Record<string, string> = {};
    for (const o of arr) {
      if (typeof o?.OutputKey === "string" && typeof o?.OutputValue === "string") out[o.OutputKey] = o.OutputValue;
    }
    return out;
  } catch {
    return {};
  }
}

/** The `--parameter-overrides file://` payload: a JSON array of "Key=Value" strings. The auth seed
 *  is CHUNKED across FastagentAuthSeed(2…) — AgentCore env values cap at 2048 chars and a real OAuth
 *  auth.json's base64 exceeds it; `start` reassembles (collectAuthSeed). Every chunk is emitted on
 *  every deploy, including empty trailing chunks, so CloudFormation cannot retain stale values. */
export function paramsFileContent(
  imageUri: string,
  secrets: Record<string, string>,
  forwarder?: { bucket: string; key: string },
): string {
  const params = [`ImageUri=${imageUri}`];
  if (forwarder) params.push(`StateBucket=${forwarder.bucket}`, `ForwarderS3Key=${forwarder.key}`);
  for (const [k, v] of Object.entries(secrets)) {
    if (k !== "FASTAGENT_AUTH_SEED") params.push(`${cfnParamName(k)}=${v}`);
  }
  const seed = secrets.FASTAGENT_AUTH_SEED ?? "";
  for (let i = 0; i < AUTH_SEED_MAX_CHUNKS; i++) {
    const param = i === 0 ? "FastagentAuthSeed" : `FastagentAuthSeed${i + 1}`;
    params.push(`${param}=${seed.slice(i * AUTH_SEED_CHUNK_SIZE, (i + 1) * AUTH_SEED_CHUNK_SIZE)}`);
  }
  return `${JSON.stringify(params)}\n`;
}

export interface CheckpointReply {
  written: boolean;
  reason?: string;
}

/** Parse the runtime's checkpoint acknowledgement without treating malformed output as success. */
export function parseCheckpointReply(stdout: string): CheckpointReply | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("written" in parsed) ||
      typeof parsed.written !== "boolean"
    ) {
      return undefined;
    }
    return {
      written: parsed.written,
      reason: "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Run the deploy through `aws` + `docker`. `log` reports progress; the injected registrars perform
 * post-deploy webhook steps from the builder machine against the forwarder's Function URL. Every
 * gate is fail-visible; `writeSecretFile` is the caller's 0600-temp-file seam (see the header).
 */
export async function deployAgentcoreRun(
  plan: AgentcoreRunPlan,
  aws: CliRunner,
  docker: CliRunner,
  log: (msg: string) => void,
  writeSecretFile: (content: string) => Promise<string>,
  writeForwarderZip: (bytes: Uint8Array) => Promise<string>,
  registerTelegram: (baseUrl: string) => Promise<RegistrationOutcome>,
  registerFeishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>,
  registerSlack?: (baseUrl: string) => Promise<RegistrationOutcome>,
  /** Injected in tests; the probe itself stays inside the run so no deploy can skip it. */
  probe: { fetchImpl?: typeof fetch; timeoutMs?: number; intervalMs?: number } = {},
): Promise<AgentcoreRunOutcome> {
  const gate = (g: string): AgentcoreRunOutcome => ({ ok: false, gate: g });
  const stack = `fastagent-${plan.name}`;
  const repo = `fastagent/${plan.name}`;

  // 1. Identity + region — the two facts everything downstream (registry hostname, stack region)
  //    hangs on. `sts get-caller-identity` succeeds with any working credential source.
  const identity = await aws(["sts", "get-caller-identity", "--output", "json"], { capture: true });
  if (identity.code === 127) {
    return gate("aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/, then re-run");
  }
  if (identity.code !== 0) {
    return gate("no working AWS credentials — run `aws configure` (or set AWS_ACCESS_KEY_ID/…), then re-run");
  }
  let account: string;
  try {
    const parsed = JSON.parse(identity.stdout) as { Account?: unknown };
    if (typeof parsed.Account !== "string") throw new Error("no Account");
    account = parsed.Account;
  } catch {
    return gate("could not read the account id from `aws sts get-caller-identity` — see the output above");
  }
  let region = plan.region;
  if (!region) {
    const fromConfig = await aws(["configure", "get", "region"], { capture: true });
    region = fromConfig.stdout.trim() || undefined;
  }
  if (!region) {
    return gate("no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run");
  }

  // 2. Docker + buildx — this host builds LOCALLY (linux/arm64 into the account's ECR; AgentCore has
  //    no remote builder), so their absence is a first-class gate with the install pointer. ANY
  //    non-zero gates BEFORE side effects: `docker version` with the daemon down exits non-127, and
  //    letting it through would create the ECR repo and then fail the build with a generic error.
  const dockerVersion = await docker(["version"], { capture: true });
  if (dockerVersion.code === 127) {
    return gate("docker not found — install Docker (https://docs.docker.com/get-docker/), then re-run");
  }
  if (dockerVersion.code !== 0) {
    return gate("docker daemon not reachable — start Docker Desktop (or fix your docker context), then re-run");
  }
  if ((await docker(["buildx", "version"], { capture: true })).code !== 0) {
    return gate(
      "docker buildx not available — the image must be linux/arm64 (cross-built); install buildx, then re-run",
    );
  }

  // 3. Gate missing required secret VALUES before any side effect (no half-created infra).
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no local value for: ${plan.missingSecrets.join(", ")} — set them in .env (or the environment) and re-run`,
    );
  }
  // 3b. AgentCore env values cap at 2048 chars. The auth seed is chunked (paramsFileContent) up to
  //     its ceiling; any OTHER oversized value has no chunk lane — gate it instead of a cryptic
  //     CloudFormation "maxLength" failure mid-deploy.
  const seed = plan.secrets.FASTAGENT_AUTH_SEED;
  if (seed && seed.length > AUTH_SEED_CHUNK_SIZE * AUTH_SEED_MAX_CHUNKS) {
    return gate(
      `your auth.json is too large to carry (${seed.length} chars base64 > ${AUTH_SEED_CHUNK_SIZE * AUTH_SEED_MAX_CHUNKS}) — ` +
        `slim it (keep only the model's credential), or set a provider API key in .env instead`,
    );
  }
  for (const [k, v] of Object.entries(plan.secrets)) {
    if (k !== "FASTAGENT_AUTH_SEED" && v.length > 2048) {
      return gate(`secret ${k} is ${v.length} chars — AgentCore environment values cap at 2048; shorten it`);
    }
  }

  // 4. ECR repository — check-then-act. A FAILED describe that isn't "not found" would misreport the
  //    create, but ECR's not-found also exits non-zero — so try describe, and on failure attempt the
  //    create; a create failing for a REAL reason (permissions) still gates with its own message.
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const image = `${registry}/${repo}:${plan.tag}`;
  const described = await aws(["ecr", "describe-repositories", "--repository-names", repo], { capture: true });
  if (described.code === 0) {
    log(`ECR repository ${repo} exists — skipping create`);
  } else {
    log(`creating ECR repository ${repo}…`);
    if ((await aws(["ecr", "create-repository", "--repository-name", repo])).code !== 0) {
      return gate("`aws ecr create-repository` failed — see the output above; fix and re-run");
    }
  }

  // 4b. The deployment bucket + the forwarder package. The bucket is created OUTSIDE the stack, on
  //     purpose and unlike everything else here: it holds the agent's STATE SNAPSHOT, and AgentCore
  //     wipes the /mnt/state mount on every runtime version update (i.e. every deploy). Keeping it
  //     out of CloudFormation means a `delete-stack` — or a rolled-back create — cannot take the
  //     agent's sessions, channel state and pending wake-ups with it.
  let forwarderParams: { bucket: string; key: string } | undefined;
  if (plan.needsForwarder) {
    const bucket = stateBucketName(plan.name, account);
    if ((await aws(["s3api", "head-bucket", "--bucket", bucket], { capture: true })).code !== 0) {
      log(`creating deployment bucket ${bucket}…`);
      // us-east-1 is the ONE region that must not carry a LocationConstraint (the API rejects it).
      const createArgs = ["s3api", "create-bucket", "--bucket", bucket];
      if (region !== "us-east-1") createArgs.push("--create-bucket-configuration", `LocationConstraint=${region}`);
      if ((await aws(createArgs)).code !== 0) {
        return gate(`\`aws s3api create-bucket --bucket ${bucket}\` failed — see the output above; fix and re-run`);
      }
    }
    // CONVERGE the properties on EVERY deploy, not just at creation. They are what makes the bucket
    // safe (nothing public) and recoverable (a bad write is not the end of the agent's memory); doing
    // them only in the create branch means a run that failed halfway leaves a bucket that looks
    // finished forever after, and ignoring the exit codes means "deployed" would be reported over a
    // world-readable or unversioned store of the agent's credentials.
    const converge: { label: string; args: string[] }[] = [
      {
        label: "block public access",
        args: [
          "s3api",
          "put-public-access-block",
          "--bucket",
          bucket,
          "--public-access-block-configuration",
          "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
        ],
      },
      {
        label: "enable versioning",
        args: ["s3api", "put-bucket-versioning", "--bucket", bucket, "--versioning-configuration", "Status=Enabled"],
      },
      {
        label: "set the snapshot lifecycle",
        args: [
          "s3api",
          "put-bucket-lifecycle-configuration",
          "--bucket",
          bucket,
          "--lifecycle-configuration",
          JSON.stringify({
            Rules: [
              {
                ID: "fastagent-expire-old-snapshots",
                Status: "Enabled",
                Filter: { Prefix: "state/" },
                NoncurrentVersionExpiration: { NoncurrentDays: 7 },
              },
            ],
          }),
        ],
      },
    ];
    for (const step of converge) {
      // `capture` keeps the CLI's JSON off the deploy log: the exit code is the signal, and a failure
      // gates with the step's name below.
      if ((await aws(step.args, { capture: true })).code !== 0) {
        return gate(`could not ${step.label} on ${bucket} — refusing to store agent state in it; fix and re-run`);
      }
    }
    // Content-hashed key: CloudFormation rolls the function only when a parameter VALUE changes, so
    // identical source must map to an identical key (hence the deterministic zip) and changed source
    // to a new one.
    const zip = zipSingleFile("index.js", Buffer.from(forwarderSource()));
    const key = `forwarder/${createHash("sha256").update(zip).digest("hex").slice(0, 16)}.zip`;
    const zipPath = await writeForwarderZip(zip);
    if ((await aws(["s3", "cp", zipPath, `s3://${bucket}/${key}`])).code !== 0) {
      return gate("uploading the forwarder package to S3 failed — see the output above; fix and re-run");
    }
    forwarderParams = { bucket, key };
  }

  // 5. Registry login — the password flows stdout→stdin between the two runners, never argv.
  const password = await aws(["ecr", "get-login-password"], { capture: true });
  if (password.code !== 0) return gate("`aws ecr get-login-password` failed — see the output above");
  if (
    (await docker(["login", "--username", "AWS", "--password-stdin", registry], { input: password.stdout })).code !== 0
  ) {
    return gate("`docker login` to ECR failed — see the output above");
  }

  // 6. Build (linux/arm64) + push in one step.
  log(`building + pushing ${image} (linux/arm64)…`);
  const buildArgs = ["buildx", "build", "--platform", "linux/arm64", "-t", image, "--push"];
  if (plan.dockerfilePath) buildArgs.push("-f", plan.dockerfilePath);
  buildArgs.push(".");
  if ((await docker(buildArgs)).code !== 0) {
    return gate("`docker buildx build` failed — see the output above; fix and re-run");
  }

  // 7. Deploy the stack. Secret values ride the temp params file (file://), never argv.
  //    --no-fail-on-empty-changeset: a re-run whose only change already applied must not gate.
  //    Self-heal the one un-resumable state first: a FAILED first create leaves the stack in
  //    ROLLBACK_COMPLETE, which CloudFormation refuses to update — without this, "fix and re-run"
  //    (our own gate advice) would dead-end on a different error. Nothing real is lost by deleting:
  //    a ROLLBACK_COMPLETE stack holds no live resources.
  const status = await aws(
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stack,
      "--query",
      "Stacks[0].StackStatus",
      "--output",
      "text",
    ],
    { capture: true },
  );
  if (status.code === 0 && status.stdout.trim() === "ROLLBACK_COMPLETE") {
    log(`stack ${stack} is ROLLBACK_COMPLETE (a failed first create) — deleting it before re-creating…`);
    if ((await aws(["cloudformation", "delete-stack", "--stack-name", stack])).code !== 0) {
      return gate("`aws cloudformation delete-stack` failed — see the output above");
    }
    if ((await aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stack])).code !== 0) {
      return gate("waiting for the stack delete failed — see the output above; re-run once it is gone");
    }
  }
  log(`deploying stack ${stack}…`);
  const paramsPath = await writeSecretFile(paramsFileContent(image, plan.secrets, forwarderParams));
  const deployed = await aws([
    "cloudformation",
    "deploy",
    "--stack-name",
    stack,
    "--template-file",
    plan.templatePath,
    "--capabilities",
    "CAPABILITY_IAM",
    "--no-fail-on-empty-changeset",
    "--parameter-overrides",
    `file://${paramsPath}`,
  ]);
  if (deployed.code !== 0) {
    return gate(
      "`aws cloudformation deploy` failed — inspect the stack events " +
        `(aws cloudformation describe-stack-events --stack-name ${stack}), fix, and re-run`,
    );
  }

  // 8. Outputs — the runtime ARN (the data plane) and the forwarder URL (the webhook surface).
  const outputsQuery = await aws(
    ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
    { capture: true },
  );
  if (outputsQuery.code !== 0) return gate("`aws cloudformation describe-stacks` failed — see the output above");
  const outputs = parseStackOutputs(outputsQuery.stdout);
  const runtimeArn = outputs.RuntimeArn;
  if (!runtimeArn) return gate("stack has no RuntimeArn output — was the template edited? Regenerate with --force");
  const url = outputs.ForwarderUrl?.replace(/\/$/, ""); // registrars append /<path>; no double slash

  // 8b. Restart the ingress session so the new image serves IMMEDIATELY. A live session keeps its
  //     old compute until the idle timeout or the max compute lifetime (8 h) — without this, a
  //     redeploy "succeeds" while an actively-chatting session keeps answering from the PREVIOUS
  //     image (the exact silent trap the first real deploy hit). Failure is advisory, never a gate:
  //     on a first deploy the session does not exist yet, and the stop is an immediacy optimization
  //     — the platform's reclaim gets there eventually. An in-flight turn on the old compute is cut;
  //     the checkpoint above is what lets a replaying channel re-run it. Only when a forwarder exists
  //     (the ingress session is the forwarder's session; pure-invoke deployments have none).
  // Keyed on the FORWARDER: every current forwarder has a callback URL for state-capability refresh,
  // and every forwarder topology has an ingress session whose next event would otherwise land on compute still
  // running the previous image.
  if (plan.needsForwarder) {
    // CHECKPOINT FIRST. The stop cuts whatever turn is running, and that turn's durable intent was
    // written to a mount the version update erases — so without this flush "replay re-runs it" would
    // be false: the intent never reaches S3 and the message is simply gone. Best-effort: a session
    // that is not up has nothing to lose, and a failure here must not block the (already applied)
    // deploy — it only downgrades the promise, so say so.
    const checkpointPayloadPath = await writeSecretFile(
      `${JSON.stringify({ kind: "checkpoint", auth: plan.secrets.FASTAGENT_INGRESS_SECRET })}\n`,
    );
    const checkpoint = await aws(
      [
        "bedrock-agentcore",
        "invoke-agent-runtime",
        "--agent-runtime-arn",
        runtimeArn,
        "--runtime-session-id",
        ingressSessionId(plan.name),
        "--payload",
        `file://${checkpointPayloadPath}`,
        "--cli-binary-format",
        "raw-in-base64-out",
        "/dev/stdout",
      ],
      { capture: true, captureStderr: true },
    );
    // Report what the container ACTUALLY did. This line is the only signal an operator has about
    // whether an in-flight turn survived the deploy, so a blanket "checkpointed" — printed even when
    // nothing was written — would be worse than no line at all.
    if (checkpoint.code !== 0) {
      log(
        "note: could not reach the ingress session to checkpoint — if a turn was in flight it is lost " +
          "rather than replayed (see the output above)",
      );
    } else {
      const reply = parseCheckpointReply(checkpoint.stdout);
      if (reply?.written) {
        log("checkpointed the ingress session (an interrupted turn can be replayed)");
      } else if (reply) {
        // The ordinary case: the session was already idle-reclaimed, so its snapshot was written when
        // it settled and there is nothing in flight to lose.
        log(`note: nothing to checkpoint${reply.reason ? ` — ${reply.reason}` : " (no session was running)"}`);
      } else {
        log("warn: ingress session returned an invalid checkpoint response — could not verify the state snapshot");
      }
    }
    log("stopping the ingress session so the new image serves immediately…");
    const stopCommand = [
      "bedrock-agentcore",
      "stop-runtime-session",
      "--agent-runtime-arn",
      runtimeArn,
      "--runtime-session-id",
      ingressSessionId(plan.name),
    ];
    const stopped = await aws(stopCommand, { capture: true, captureStderr: true });
    if (stopped.code !== 0) {
      // Classify, don't guess: "no session yet" (first deploy — expected, quiet note) vs a REAL stop
      // failure (permissions/CLI/network — the old image may keep serving, say so loudly with the
      // manual command). Not a gate: the deploy itself succeeded, and stop is an immediacy
      // optimization — the platform's reclaim converges regardless.
      const stderr = stopped.stderr ?? "";
      if (/ResourceNotFound|not\s*found|does not exist/i.test(stderr)) {
        log("note: no ingress session to stop (first deploy, or already reclaimed)");
      } else {
        // A GATE, not a warning: the probe below reaches the SAME fixed session id, so a session
        // still running the previous image would answer it and the deploy would claim to have
        // verified a serving path it never touched. Unable to guarantee the session is fresh =
        // unable to verify = stop.
        const firstLine = stderr.trim().split("\n")[0];
        return gate(
          `could not stop the ingress session — it may still be serving the PREVIOUS image, so the ` +
            `deploy cannot verify the new one${firstLine ? ` (${firstLine})` : ""}. ` +
            `Stop it manually (aws ${stopCommand.join(" ")}) and re-run`,
        );
      }
    }
  }

  // 8c. Every forwarder topology MUST carry the ForwarderUrl output — schedule-only and
  //     selfSchedule-only deployments included, since the probe below is their only construction
  //     check (there is no boot-time failStartup on this host). A missing output means an edited
  //     template; skipping the probe silently would let such a deploy report success unverified.
  //     Only a pure-invoke deployment (no forwarder) legitimately has no URL and nothing to probe.
  //     `channels.length` is belt-and-braces: the planner derives needsForwarder FROM the channel
  //     list, but this gate must not silently trust that invariant across callers.
  if ((plan.needsForwarder || plan.channels.length > 0) && !url) {
    return gate(
      "this deployment needs the forwarder but the stack has no ForwarderUrl output — regenerate the " +
        "template with --force",
    );
  }

  // 8d. Warm + verify the NEW serving path end to end, BEFORE registration: the probe wakes a fresh
  //     session on the new image through the forwarder's reserved path, which restores the state
  //     snapshot and constructs the channels — construction is deferred to exactly that moment
  //     (channels/agentcore.ts), so this is where a bad credential, a broken channels/ module, or an
  //     unrestorable snapshot surfaces AT DEPLOY TIME with the runtime's own error text.
  if (url) {
    log("probing the deployed runtime (state restore + channel construction)…");
    const verdict = await probeRuntime(
      `${url}/__fastagent/probe`,
      plan.secrets.FASTAGENT_INGRESS_SECRET ?? "",
      probe.fetchImpl ?? fetch,
      probe.timeoutMs,
      probe.intervalMs,
    );
    if (!verdict.ok) return gate(verdict.gate);
    log("runtime verified (state restored, channels constructed)");
  }

  // 9. Post-deploy webhook registration — same registrar seam as every host, pointed at the
  //    forwarder's Function URL. Gate policy is the shared registration-gate kernel.
  const reg = registrationGate(log, "re-run to retry registration (steps already done are skipped)");
  if (url) {
    if (plan.channels.includes("telegram")) {
      log("registering telegram webhook…");
      reg.track("telegram", await registerTelegram(url));
    }
    if (plan.channels.includes("github")) {
      log(`github: set the webhook in the repo (Settings → Webhooks) → ${url}/webhook`);
      reg.track("github", "manual"); // always a human step — re-surfaced after the registrar output
    }
    if (plan.channels.includes("slack")) {
      if (registerSlack) {
        log("registering slack event URL…");
        reg.track("slack", await registerSlack(url));
      } else {
        log(`slack: set Event Subscriptions → Request URL → ${url}/slack`);
        reg.track("slack", "manual");
      }
    }
    for (const kind of ["feishu", "lark"] as const) {
      if (!plan.channels.includes(kind)) continue;
      if (registerFeishu) {
        log(`registering ${kind} event URL…`);
        reg.track(kind, await registerFeishu(url, kind));
      } else {
        log(`${kind}: set the event Request URL (developer console → Events & Callbacks) → ${url}/${kind}`);
        reg.track(kind, "manual");
      }
    }
  }
  const registrationGateMsg = reg.gate();
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true, runtimeArn, url };
}
