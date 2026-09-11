/** `fastagent deploy agentcore --run` — drive the AWS CLI + Docker to completion. */
import { RESERVED_PATHS } from "../../channels/agentcore-protocol.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import { type Registrars, registerWebhooks } from "../channel-ingress.ts";
import type { CliRunner } from "../runner.ts";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  AUTH_SEED_CHUNK_SIZE,
  AUTH_SEED_MAX_CHUNKS,
  type AgentcoreTopology,
  cfnParamName,
  forwarderSource,
  ingressSessionId,
  deploymentBucketName,
} from "./plan.ts";
import { zipSingleFile } from "./zip.ts";

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
  /** Secret env-var name → value (model key or FASTAGENT_AUTH_SEED + channel secrets). */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — gated before any side effect. */
  missingSecrets: string[];
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /**
   * What the stack contains — the plan's own reading, so this driver cannot disagree with the template about whether a
   * forwarder (and its artifact bucket parameters) exists.
   */
  topology: AgentcoreTopology;
}

export type AgentcoreRunOutcome = { ok: true; runtimeArn: string; url?: string } | { ok: false; gate: string };

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

/** The `--parameter-overrides file://` payload: a JSON array of "Key=Value" strings. */
export function paramsFileContent(
  imageUri: string,
  secrets: Record<string, string>,
  forwarder?: { bucket: string; key: string },
): string {
  const params = [`ImageUri=${imageUri}`];
  if (forwarder) params.push(`ForwarderBucket=${forwarder.bucket}`, `ForwarderS3Key=${forwarder.key}`);
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
  const stack = `fastagent-${plan.name}`;
  const repo = `fastagent/${plan.name}`;

  // 1.
  const identity = await aws(["sts", "get-caller-identity", "--output", "json"], { capture: true });
  if (identity.code === 127) {
    return gate("aws CLI not found — install AWS CLI v2: https://docs.aws.amazon.com/cli/, then re-run");
  }
  if (identity.code !== 0) {
    return gate("no working AWS credentials — run `aws configure` (or set AWS_ACCESS_KEY_ID/…), then re-run");
  }
  let account: string;
  let principal: string | undefined;
  try {
    const parsed = JSON.parse(identity.stdout) as { Account?: unknown; Arn?: unknown };
    if (typeof parsed.Account !== "string") throw new Error("no Account");
    account = parsed.Account;
    principal = typeof parsed.Arn === "string" ? parsed.Arn : undefined;
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
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no value for: ${plan.missingSecrets.join(", ")} — the deployed environment is declared by the agent's
        .secrets/.env, and this deploy reads only that file (exporting the variable here does not reach the
        deployment). Add them there and re-run`,
    );
  }
  // 3b.
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
  // Name what travels from THIS machine's environment onto the runtime: the list is no longer only
  // what the author typed in deploy.secrets (a mounted tool/channel/schedule declares its own).
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

  // 4.
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

  // The forwarder package must exist before CloudFormation can create its Lambda.
  let forwarderParams: { bucket: string; key: string } | undefined;
  if (plan.topology.forwarder) {
    const bucket = deploymentBucketName(plan.name, account);
    if ((await aws(["s3api", "head-bucket", "--bucket", bucket], { capture: true })).code !== 0) {
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
  buildArgs.push("-f", plan.dockerfilePath);
  buildArgs.push(".");
  if ((await docker(buildArgs)).code !== 0) {
    return gate("`docker buildx build` failed — see the output above; fix and re-run");
  }

  // 7.
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
    const stopped = await aws(stopCommand, { capture: true, captureStderr: true });
    if (stopped.code !== 0) {
      // Classify, don't guess: "no session yet" (first deploy — expected, quiet note) vs a REAL stop failure
      // (permissions/CLI/network), which must stop verification against the previous image.
      const stderr = stopped.stderr ?? "";
      // The message follows the ANSWER (no session to stop vs a real failure).
      const noSession = /ResourceNotFound|not\s*found|does not exist/i.test(stderr);
      if (noSession || !plan.topology.forwarder) {
        log(
          noSession
            ? "note: no ingress session to stop (first deploy, or already reclaimed)"
            : `note: could not stop the ingress session (${stderr.trim().split("\n")[0]}) — the previous image may keep serving until it is reclaimed`,
        );
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
  if (plan.topology.forwarder && !url) {
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
