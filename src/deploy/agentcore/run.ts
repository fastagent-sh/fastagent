/** `fastagent deploy agentcore --run` — drive the AWS CLI + Docker to completion. */
import { RESERVED_PATHS } from "../../channels/agentcore-protocol.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import { type Registrars, registerWebhooks } from "../channel-ingress.ts";
import type { CliRunner } from "../runner.ts";
import { awsCli, awsJson } from "./aws-cli.ts";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  CARRIERS,
  CARRIER_CHUNK_SIZE,
  CARRIER_MAX_CHUNKS,
  MOUNT,
  agentcoreRepoName,
  agentcoreStackName,
  carrierChunk,
  deploymentBucketName,
  forwarderSource,
  ingressSessionId,
  type AgentcoreTopology,
} from "./plan.ts";
import { zipSingleFile } from "./zip.ts";
import { encodeCarriedEnv, missingValuesGate } from "../secrets.ts";

export interface AgentcoreRunPlan {
  /** The base name — stack `fastagent-<name>`, ECR repo `fastagent/<name>`. */
  name: string;
  /** Template path relative to the run cwd (kit layout: `agent/agentcore.template.yaml`). */
  templatePath: string;
  /** Dockerfile path for `-f`. */
  dockerfilePath: string;
  /** Image tag for this deploy — the CALLER mints it unique (a timestamp). */
  tag: string;
  /**
   * AWS region from the caller's environment (AWS_REGION/AWS_DEFAULT_REGION), else resolved via `aws configure get
   * region`.
   */
  region?: string;
  /** Env-var name → value: the value file's carried variables, plus FASTAGENT_AUTH_SEED for a file credential. */
  secrets: Record<string, string>;
  /** Declared names the value file supplies no value for — the run gates on these before any side effect. */
  missingSecrets: string[];
  /** That value file, workspace-relative, so the gate names the file this deploy actually read. */
  valueFile: string;
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /**
   * What the stack contains — the plan's own reading, so this driver cannot disagree with the template about whether a
   * forwarder (and its artifact bucket parameters) exists.
   */
  topology: AgentcoreTopology;
}

export type AgentcoreRunOutcome = { ok: true; runtimeArn: string; url?: string } | { ok: false; gate: string };

/**
 * Stack statuses that hold NO agent memory: a create that never succeeded, its rollback, a change set never
 * executed, or a stack already gone. Everything else — including `UPDATE_ROLLBACK_COMPLETE` and any status AWS adds
 * later — is treated as carrying state, so an unrecognized status over-warns instead of quietly promising nothing is
 * lost.
 */
const EMPTY_STACK_STATUSES = new Set([
  "CREATE_FAILED",
  "CREATE_IN_PROGRESS",
  "ROLLBACK_IN_PROGRESS",
  "ROLLBACK_FAILED",
  "ROLLBACK_COMPLETE",
  "REVIEW_IN_PROGRESS",
  "DELETE_COMPLETE",
]);

/** Budget for image pull, storage initialization and channel construction. */
const PROBE_TIMEOUT_MS = 240_000;
const PROBE_INTERVAL_MS = 3_000;

/** Drive the forwarder's reserved probe path until it answers, and read the runtime's STRUCTURED verdict. */
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
          // malformed — fall through to retry with it as the last answer
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
      // not routable yet (Function URL DNS, cold start) — keep polling until the deadline
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
/**
 * `Stacks[0].Outputs` as a map, or `undefined` when the document is not that list at all.
 *
 * `null` IS AN ANSWER, and an empty map is what it says: that is what JMESPath prints for a stack with no
 * Outputs section, i.e. a template edited or generated without one. Reading it as unreadable blamed
 * `aws cloudformation describe-stacks` — a command that had just succeeded — instead of letting the caller's
 * own "no RuntimeArn, regenerate with --force" gate say what to do. Distinct from empty stdout, which is the
 * CLI printing nothing at all (aws-cli.ts, point 4).
 */
export function pickStackOutputs(parsed: unknown): Record<string, string> | undefined {
  if (parsed === null) return {};
  if (!Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  for (const o of parsed as { OutputKey?: unknown; OutputValue?: unknown }[]) {
    if (typeof o?.OutputKey === "string" && typeof o?.OutputValue === "string") out[o.OutputKey] = o.OutputValue;
  }
  return out;
}
/** The secrets `--run` mints for this host, each with the template parameter of its own. */
const MINTED_PARAMS: Record<string, string> = {
  FASTAGENT_INGRESS_SECRET: "FastagentIngressSecret",
  FASTAGENT_WAKE_SECRET: "FastagentWakeSecret",
};

/** What each carrier holds for this deploy: the credential seed, and every other variable as one encoded object. */
function carrierValues(secrets: Record<string, string>): Record<(typeof CARRIERS)[number]["env"], string> {
  const { FASTAGENT_AUTH_SEED: seed = "", ...rest } = secrets;
  const carried = Object.fromEntries(Object.entries(rest).filter(([name]) => !(name in MINTED_PARAMS)));
  return { FASTAGENT_AUTH_SEED: seed, FASTAGENT_ENV: encodeCarriedEnv(carried) };
}

/** The `--parameter-overrides file://` payload: a JSON array of "Key=Value" strings. */
export function paramsFileContent(
  imageUri: string,
  secrets: Record<string, string>,
  forwarder: { bucket: string; key: string },
): string {
  const params = [`ImageUri=${imageUri}`, `ForwarderBucket=${forwarder.bucket}`, `ForwarderS3Key=${forwarder.key}`];
  for (const [name, param] of Object.entries(MINTED_PARAMS)) {
    if (secrets[name] !== undefined) params.push(`${param}=${secrets[name]}`);
  }
  // Every chunk is written, empty ones included: an omitted parameter keeps its PREVIOUS value on a stack update.
  const values = carrierValues(secrets);
  for (const carrier of CARRIERS) {
    const value = values[carrier.env];
    for (let i = 0; i < CARRIER_MAX_CHUNKS; i++) {
      params.push(
        `${carrierChunk(carrier, i).param}=${value.slice(i * CARRIER_CHUNK_SIZE, (i + 1) * CARRIER_CHUNK_SIZE)}`,
      );
    }
  }
  return `${JSON.stringify(params)}\n`;
}

/** Run the deploy through `aws` + `docker`. */
export async function deployAgentcoreRun(
  plan: AgentcoreRunPlan,
  aws: CliRunner,
  docker: CliRunner,
  log: (msg: string) => void,
  writeSecretFile: (content: string) => Promise<string>,
  writeForwarderZip: (bytes: Uint8Array) => Promise<string>,
  registrars: Registrars,
  /** Injected in tests; the probe itself stays inside the run so no deploy can skip it. */
  probe: { fetchImpl?: typeof fetch; timeoutMs?: number; intervalMs?: number } = {},
): Promise<AgentcoreRunOutcome> {
  const gate = (g: string): AgentcoreRunOutcome => ({ ok: false, gate: g });
  const stack = agentcoreStackName(plan.name);
  const repo = agentcoreRepoName(plan.name);

  // 1.
  const cli = awsCli(aws);
  const identity = await cli.read(
    ["sts", "get-caller-identity", "--output", "json"],
    awsJson((parsed) => {
      const { Account, Arn } = (parsed ?? {}) as { Account?: unknown; Arn?: unknown };
      return typeof Account === "string"
        ? { account: Account, principal: typeof Arn === "string" ? Arn : undefined }
        : undefined;
    }),
  );
  if (!("ok" in identity)) {
    if ("absent" in identity) return gate("`aws sts get-caller-identity` found no caller — run `aws configure`");
    if (identity.code === 127) return gate(`${identity.unreadable}, then re-run`);
    // QUOTED: expired token, a missing profile and a proxy that eats STS are three different next actions.
    return gate(`no working AWS credentials (${identity.unreadable}) — run \`aws configure\`, then re-run`);
  }
  const { account, principal } = identity.ok;
  let region = plan.region;
  if (!region) {
    const fromConfig = await aws(["configure", "get", "region"], { capture: true });
    region = fromConfig.stdout.trim() || undefined;
  }
  if (!region) {
    return gate("no AWS region configured — set AWS_REGION (or `aws configure set region <region>`), then re-run");
  }

  // 2.
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
  const missingValues = missingValuesGate(plan.missingSecrets, plan.valueFile);
  if (missingValues) return gate(missingValues);
  // 3b.
  const capacity = CARRIER_CHUNK_SIZE * CARRIER_MAX_CHUNKS;
  const carried = carrierValues(plan.secrets);
  if (carried.FASTAGENT_AUTH_SEED.length > capacity) {
    return gate(
      `your auth.json is too large to carry (${carried.FASTAGENT_AUTH_SEED.length} chars base64 > ${capacity}) — ` +
        `slim it (keep only the model's credential), or set a provider API key in .env instead`,
    );
  }
  if (carried.FASTAGENT_ENV.length > capacity) {
    return gate(
      `the variables in ${plan.valueFile} are too large to carry (${carried.FASTAGENT_ENV.length} chars encoded > ` +
        `${capacity}) — move what the deployment does not need out of that file`,
    );
  }
  // Name what travels from the value file onto the runtime.
  const secretNames = Object.keys(plan.secrets);
  if (secretNames.length > 0) log(`carrying ${secretNames.length} secret(s): ${secretNames.join(", ")}`);

  // 3c. Say what this deploy is ABOUT TO TOUCH while it can still be stopped for free: until here the account and
  // region only surfaced several hundred log lines in, inside the ECR image URI.
  const source = plan.region ? "the environment" : "aws configure";
  log(
    `account ${account}${principal ? ` (${principal})` : ""}, region ${region} (from ${source}), image ${repo}:${plan.tag}`,
  );
  if (principal?.endsWith(":root")) {
    log(`warn: deploying as the account root user — this stack's IAM roles are created under it; prefer an IAM role`);
  }
  // Warn, never gate: an aws CLI too old to know the service, or a role without ListAgentRuntimes, would make a gate
  // refuse a valid deploy. The point is to say it BEFORE the multi-minute arm64 build, not to be authoritative.
  // `--region` explicitly: every other region-dependent call here writes it out (the ECR registry URI, the bucket's
  // LocationConstraint), and the warning below names ${region} — the probe must be about the SAME region it names.
  const service = await aws(
    ["bedrock-agentcore-control", "list-agent-runtimes", "--max-items", "1", "--region", region],
    {
      capture: true,
      captureStderr: true,
    },
  );
  if (service.code !== 0) {
    const why = (service.stderr ?? "").trim().split("\n")[0];
    log(
      `warn: could not confirm AgentCore is available in ${region}${why ? ` (${why})` : ""} — if it is not, ` +
        `cloudformation deploy fails minutes from now, after the image build: ` +
        `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html`,
    );
  }

  // 3d. Read the stack here, for the two questions that both depend on it: does this deploy destroy the agent's
  // memory (below), and is there a failed first create to clear (step 7)? The destructive one is only worth saying
  // while the multi-minute build has not run yet, and step 7 reuses this answer unless it was still in flight.
  // An unanswered question must not read as "a first deploy, nothing to lose": `sts get-caller-identity` succeeding
  // says nothing about whether this role can read CloudFormation. That three-way answer is aws-cli.ts's.
  const readStackStatus = () =>
    cli.read(
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
      (stdout) => stdout.trim() || undefined,
    );
  const stackStatus = await readStackStatus();
  const status = "ok" in stackStatus ? stackStatus.ok : "";
  // The only answers the build can invalidate: one still in flight (a first create rolling back is exactly what step 7
  // exists for, and minutes of arm64 build are long enough for it to settle), and one we never got.
  const settling = status.endsWith("_IN_PROGRESS") || "unreadable" in stackStatus;
  // Warn, never gate — same as the region probe above: a role without this read, or an older CLI, must not refuse a
  // legitimate deploy.
  if ("unreadable" in stackStatus) {
    log(
      `warn: could not read stack ${stack} (${stackStatus.unreadable}) — if it exists, this deploy resets its ` +
        `managed SessionStorage (${MOUNT}) and a failed first create will not be cleared`,
    );
  } else if (status !== "" && !EMPTY_STACK_STATUSES.has(status)) {
    log(
      `warn: this is a REDEPLOY and AWS resets managed SessionStorage (${MOUNT}) on every runtime version update — ` +
        `sessions, channel state and pending wake-ups start blank` +
        // Only the carried auth.json is re-seeded; a provider API key deployment has no such step to blame.
        `${carried.FASTAGENT_AUTH_SEED ? ", and the model credential is re-seeded from FASTAGENT_AUTH_SEED" : ""}. ` +
        `Cross-deploy memory needs a real volume: \`deploy fly\` or \`deploy railway\`.`,
    );
  }

  // 4.
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const image = `${registry}/${repo}:${plan.tag}`;
  const described = await cli.present(["ecr", "describe-repositories", "--repository-names", repo]);
  if ("unreadable" in described) {
    // NOT the create branch. A denial here used to end as "`aws ecr create-repository` failed", naming the step
    // after the one that actually went wrong.
    return gate(`could not read ECR repository ${repo} (${described.unreadable}) — fix that, then re-run`);
  }
  if ("ok" in described) {
    log(`ECR repository ${repo} exists — skipping create`);
  } else {
    log(`creating ECR repository ${repo}…`);
    if ((await aws(["ecr", "create-repository", "--repository-name", repo])).code !== 0) {
      return gate("`aws ecr create-repository` failed — see the output above; fix and re-run");
    }
  }

  // The forwarder package must exist before CloudFormation can create its Lambda.
  const bucket = deploymentBucketName(plan.name, account);
  const head = await cli.present(["s3api", "head-bucket", "--bucket", bucket]);
  // Same shape as the repository above: a 403 is not a 404, and creating on top of it fails with a message
  // about the wrong thing.
  if ("unreadable" in head) {
    return gate(`could not read deployment bucket ${bucket} (${head.unreadable}) — fix that, then re-run`);
  }
  if ("absent" in head) {
    log(`creating deployment bucket ${bucket}…`);
    // us-east-1 is the ONE region that must not carry a LocationConstraint (the API rejects it).
    const createArgs = ["s3api", "create-bucket", "--bucket", bucket];
    if (region !== "us-east-1") createArgs.push("--create-bucket-configuration", `LocationConstraint=${region}`);
    if ((await aws(createArgs)).code !== 0) {
      return gate(`\`aws s3api create-bucket --bucket ${bucket}\` failed — see the output above; fix and re-run`);
    }
  }
  if (
    (
      await aws(
        [
          "s3api",
          "put-public-access-block",
          "--bucket",
          bucket,
          "--public-access-block-configuration",
          "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
        ],
        { capture: true },
      )
    ).code !== 0
  ) {
    return gate(`could not block public access on ${bucket}; fix and re-run`);
  }
  // Content-hashed key: CloudFormation rolls the function only when a parameter VALUE changes, so identical source
  // must map to an identical key (hence the deterministic zip) and changed source to a new one.
  const zip = zipSingleFile("index.js", Buffer.from(forwarderSource()));
  const key = `forwarder/${createHash("sha256").update(zip).digest("hex").slice(0, 16)}.zip`;
  const zipPath = await writeForwarderZip(zip);
  if ((await aws(["s3", "cp", zipPath, `s3://${bucket}/${key}`])).code !== 0) {
    return gate("uploading the forwarder package to S3 failed — see the output above; fix and re-run");
  }
  const forwarderParams = { bucket, key };

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
  buildArgs.push("-f", plan.dockerfilePath);
  buildArgs.push(".");
  if ((await docker(buildArgs)).code !== 0) {
    return gate("`docker buildx build` failed — see the output above; fix and re-run");
  }

  // 7. The 3d answer stands unless it was still settling then — a second read is the narrow exception, not the rule.
  const beforeDeploy = settling ? await readStackStatus() : stackStatus;
  if ("ok" in beforeDeploy && beforeDeploy.ok === "ROLLBACK_COMPLETE") {
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
  const outputsRead = await cli.read(
    ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
    awsJson(pickStackOutputs),
  );
  if (!("ok" in outputsRead)) {
    const why = "absent" in outputsRead ? `${stack} is not there` : outputsRead.unreadable;
    return gate(`\`aws cloudformation describe-stacks\` failed after a successful deploy (${why})`);
  }
  const outputs = outputsRead.ok;
  const runtimeArn = outputs.RuntimeArn;
  if (!runtimeArn) return gate("stack has no RuntimeArn output — was the template edited? Regenerate with --force");
  const url = outputs.ForwarderUrl?.replace(/\/$/, ""); // registrars append /<path>; no double slash

  // A live session keeps its previous image. Stop the fixed writer before verifying the new release.
  {
    log("stopping the ingress session so the new image serves immediately…");
    const stopCommand = [
      "bedrock-agentcore",
      "stop-runtime-session",
      "--agent-runtime-arn",
      runtimeArn,
      "--runtime-session-id",
      ingressSessionId(plan.name),
    ];
    const stopped = await cli.write(stopCommand);
    if (!("done" in stopped)) {
      // Classify, don't guess: "no session yet" (first deploy — expected, quiet note) vs a REAL stop failure
      // (permissions/CLI/network), which must stop verification against the previous image. Both words are
      // aws-cli.ts's — this file had its own third spelling of "already gone".
      const noSession = "absent" in stopped;
      const stderr = noSession ? "" : stopped.refused;
      if (noSession) {
        log("note: no ingress session to stop (first deploy, or already reclaimed)");
      } else {
        // A GATE, not a warning: the probe below reaches the SAME fixed session id, so a session still running the
        // previous image would answer it and the deploy would claim to have verified a serving path it never touched.
        const firstLine = stderr.trim().split("\n")[0];
        return gate(
          `could not stop the ingress session — it may still be serving the PREVIOUS image, so the ` +
            `deploy cannot verify the new one${firstLine ? ` (${firstLine})` : ""}. ` +
            `Stop it manually (aws ${stopCommand.join(" ")}) and re-run`,
        );
      }
    }
  }

  // 8c.
  if (!url) {
    return gate(
      "this deployment needs the forwarder but the stack has no ForwarderUrl output — regenerate the " +
        "template with --force",
    );
  }

  // Verify storage initialization and channel construction before registering webhooks.
  if (url) {
    log("probing the deployed runtime (workspace initialization + channel construction)…");
    const verdict = await probeRuntime(
      `${url}${RESERVED_PATHS.probe}`,
      plan.secrets.FASTAGENT_INGRESS_SECRET ?? "",
      probe.fetchImpl ?? fetch,
      probe.timeoutMs,
      probe.intervalMs,
    );
    if (!verdict.ok) return gate(verdict.gate);
    log("runtime verified (workspace ready, channels constructed)");
  }

  // 9.
  const registrationGateMsg = url
    ? await registerWebhooks({
        baseUrl: url,
        channels: plan.channels,
        registrars,
        log,
        retryHint: "re-run to retry registration (steps already done are skipped)",
      })
    : undefined;
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true, runtimeArn, url };
}
