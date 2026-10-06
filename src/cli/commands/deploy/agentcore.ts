/**
 * `deploy agentcore`: one CloudFormation stack (runtime + forwarder Lambda behind a Function URL); the container
 * sets its EventBridge schedules itself; no resident process.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  type AgentcoreTopology,
  FORWARDER_FILE,
  TEMPLATE_FILE,
  agentcoreName,
  agentcoreStackName,
  forwarderLogGroup,
  ingressSessionId,
  isGeneratedAgentcoreTemplate,
  planAgentcoreDeploy,
} from "../../../deploy/agentcore/plan.ts";
import { deployAgentcoreRun, pickStackOutputs } from "../../../deploy/agentcore/run.ts";
import { awsCli, awsJson } from "../../../deploy/agentcore/aws-cli.ts";
import { agentcoreShell } from "../../../deploy/agentcore/shell.ts";
import { awsRunner, spawnRunner } from "../../../deploy/runner.ts";
import { SECRET_FILE_MODE, exists } from "../../../paths.ts";
import { assembleSecrets } from "../../../deploy/secrets.ts";
import { failStartup } from "../../fail.ts";
import { isInteractive } from "../../shared.ts";
import { type HostDeploy, boxLoginStep, registrarsFor } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

/** A copy/paste-safe POSIX shell argument for the command hints deploy prints. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const agentcoreHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith(TEMPLATE_FILE) && isGeneratedAgentcoreTemplate(content),
  async shell(agentDir) {
    const name = agentcoreName(basename(agentDir));
    const stack = agentcoreStackName(name);
    const aws = awsRunner(agentDir);
    const read = await awsCli(aws).read(
      ["cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
      awsJson(pickStackOutputs),
    );
    if ("absent" in read) throw new Error(`no AgentCore stack ${stack} in this account/region — deploy it first`);
    if ("unreadable" in read) throw new Error(`could not read AgentCore stack ${stack}: ${read.unreadable}`);
    const runtimeArn = read.ok.RuntimeArn;
    if (!runtimeArn) throw new Error(`stack ${stack} has no RuntimeArn output — redeploy it`);
    return agentcoreShell(runtimeArn, ingressSessionId(name), aws);
  },
  async deploy(ctx) {
    const { opts, agentDir, config, channels, longConnectionChannels, pre, write } = ctx;
    const { modelAuth, boxLogin, container, declaredSecrets, values, valueFile } = pre;
    if (boxLogin) {
      console.error(
        `[fastagent] note: AgentCore resets the runtime's storage on every deploy AND after 14 idle days, and the ` +
          `${boxLogin} login with it: every deploy of this agent ends with a login on the runtime, and after an idle ` +
          `reset every turn fails until \`fastagent login ${boxLogin} --deployment agentcore\` (the runtime's log says ` +
          `so). For an agent that must keep answering unattended, set ${boxLogin}'s API key in ${valueFile}.`,
      );
    }
    // Long-connection channels are STRUCTURALLY unsupported: the connection is the ingress, and a reclaimed session
    // has nothing to wake it.
    if (longConnectionChannels.length > 0) {
      const msg =
        `long-connection channel (${longConnectionChannels.map((c) => c.name).join(", ")}) cannot run on AgentCore — there is no ` +
        `resident process to hold the connection, and nothing wakes a reclaimed session. Switch the channel ` +
        `to webhook mode (its events then ride the forwarder like every other channel).`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg}`);
    }
    // Host capability limit, stated before the image is built rather than left to a line in CloudWatch.
    if (config.sessionControl === true) {
      console.error(
        `[fastagent] warn: sessionControl: true has no effect on AgentCore — /control/* is not served here. This ` +
          `host's only public ingress relays anonymous traffic to the container as trusted (the forwarder holds the ` +
          `ingress secret and attaches it), and the plane has nothing of its own to verify. Steer sessions from a ` +
          `host that serves it behind your own auth (docs/design/session-control.md §14).`,
      );
    }
    // Schedules and wake-ups need nothing from the template beyond the forwarder every stack has: the container
    // mirrors them into EventBridge schedules itself (schedule/wake-alarm.ts). A file that is not a valid
    // schedule is the pre-flight's to report.
    const acName = agentcoreName(basename(agentDir));
    // Every derived AWS name embeds acName; the tightest ceiling is the Lambda function name
    // (`fastagent-<name>-forwarder` ≤ 64 chars).
    if (acName.length > 40) {
      failStartup(
        new Error(
          `deploy stopped: the directory name maps to "${acName}" (${acName.length} chars) — AWS resource ` +
            `names derived from it exceed their limits past 40 chars. Deploy from a shorter directory name.`,
        ),
      );
    }
    const plan = planAgentcoreDeploy({
      name: acName,
      boxLogin,
      channels,
      secrets: pre.secrets,
      idleTimeoutSeconds: config.deploy?.agentcore?.idleTimeoutSeconds,
      ...container,
    });
    // The template IS the topology (forwarder, alarm wiring, secrets).
    const templateArtifact = plan.artifacts.find((a) => a.path.endsWith(TEMPLATE_FILE));
    const templateHome = join(agentDir, templateArtifact?.path ?? TEMPLATE_FILE);
    if (!opts.force && templateArtifact && (await exists(templateHome))) {
      const existing = await readFile(templateHome, "utf8");
      if (isGeneratedAgentcoreTemplate(existing) && existing !== templateArtifact.content) {
        // WHY it matters here, not WHETHER to stop: the template IS the topology, so a kept one drops the
        // difference rather than degrading visibly. Stopping a `--run` on a stale artifact is the dispatcher's
        // rule (deploy.ts) for every host and every path — stating it a second time here is how the two
        // wordings drift apart.
        console.error(
          `[fastagent] warn: ${templateArtifact.path} no longer matches this definition ` +
            `(channels or a deploy.agentcore setting changed) — the kept template would ` +
            `silently drop the difference.`,
        );
      }
    }
    await write(plan.artifacts, {
      force: !!opts.force,
      alwaysWrite: [FORWARDER_FILE],
    });
    if (opts.run) {
      return runDeployAgentcore({
        agentDir,
        name: acName,
        modelAuth,
        boxLogin,
        input: opts.input !== false && isInteractive(),
        channels,
        declaredSecrets,
        values,
        valueFile,
        topology: plan.topology,
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/** `deploy agentcore --run`: drive aws + docker to completion. */
async function runDeployAgentcore(params: {
  agentDir: string;
  name: string;
  modelAuth: string | undefined;
  /** The provider the runtime logs in to itself once it is verified (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** A person can answer the login: `--run` continues into it rather than stopping at "not logged in". */
  input: boolean;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  values: ReadonlyMap<string, string>;
  valueFile: string;
  topology: AgentcoreTopology;
}): Promise<void> {
  const { agentDir, name, channels, topology } = params;
  // Decided before the first side effect: the deploy resets the runtime's storage and the login with it, so with nobody
  // to log it in again it would end at "not logged in" AFTER replacing a runtime that was serving, with the webhooks
  // a previous deploy registered still pointing at it.
  if (params.boxLogin && !params.input) {
    failStartup(
      new Error(
        `deploy stopped: every AgentCore deploy wipes the runtime's ${params.boxLogin} login, and without a terminal ` +
          `nobody can log it in again — run this deploy in a terminal, or set ${params.boxLogin}'s API key in ` +
          `${params.valueFile}`,
      ),
    );
  }
  const { secrets, missingSecrets } = assembleSecrets({
    modelAuth: params.modelAuth,
    declared: params.declaredSecrets,
    values: params.values,
  });
  // The wake-alarm shared secret (container ↔ forwarder).
  secrets.FASTAGENT_WAKE_SECRET = crypto.randomUUID();
  // The forwarder→runtime ingress secret: what makes an envelope the forwarder's rather than any IAM principal's.
  secrets.FASTAGENT_INGRESS_SECRET = crypto.randomUUID();
  // The params temp dir holds the ONE file carrying secret values (file:// parameter-overrides — never argv);
  // 0700/0600 and removed after the run, success or gate.
  const paramsDir = await mkdtemp(join(tmpdir(), "fastagent-agentcore-"));
  try {
    const outcome = await deployAgentcoreRun(
      {
        name,
        templatePath: TEMPLATE_FILE,
        dockerfilePath: "Dockerfile",
        tag: new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, "")
          .slice(0, 14),
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        secrets,
        missingSecrets,
        valueFile: params.valueFile,
        channels,
        topology,
        ...boxLoginStep("agentcore", params, (runtimeArn: string) =>
          agentcoreShell(runtimeArn, ingressSessionId(name), awsRunner(agentDir)),
        ),
      },
      awsRunner(agentDir),
      spawnRunner("docker", agentDir),
      (m) => console.error(`[fastagent] ${m}`),
      async (content) => {
        const path = join(paramsDir, "params.json");
        await writeFile(path, content, { mode: SECRET_FILE_MODE });
        return path;
      },
      async (bytes) => {
        const path = join(paramsDir, "forwarder.zip");
        await writeFile(path, bytes);
        return path;
      },
      registrarsFor(agentDir),
    );
    if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
    console.error(`[fastagent] deployed → ${outcome.runtimeArn}`);
    if (outcome.url) console.error(`[fastagent] webhook ingress → ${outcome.url}`);
    const logsDir = shellArg(agentDir);
    console.error(`[fastagent] runtime logs → fastagent logs agentcore ${logsDir} --follow`);
    console.error(`[fastagent] forwarder logs → fastagent logs agentcore ${logsDir} --source forwarder --follow`);
    // `--run` never prints the runbook, and this is the ONE step in it that nothing else will remind anyone of: a
    // log group is created by whatever writes it, CloudWatch keeps log data indefinitely, and these logs are where
    // a failed turn's reason lives. The runtime's group name is only known after discovery, so it is named by the command that
    // resolves it — spelled out, because the line above it may be the forwarder's.
    console.error(
      `[fastagent] logs are kept FOREVER until you say otherwise: aws logs put-retention-policy ` +
        `--log-group-name <the group \`fastagent logs agentcore ${logsDir} --follow\` resolves> --retention-in-days 14`,
    );
    console.error(
      `[fastagent] ...and for the forwarder: aws logs put-retention-policy ` +
        `--log-group-name ${forwarderLogGroup(name)} --retention-in-days 14`,
    );
    console.error(
      `[fastagent] invoke: aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn ${outcome.runtimeArn} \\\n` +
        `  --runtime-session-id "${ingressSessionId(name)}" \\\n` +
        `  --payload '{"kind":"invoke","session":"cli","text":"hello"}' --cli-binary-format raw-in-base64-out /dev/stdout`,
    );
  } finally {
    await rm(paramsDir, { recursive: true, force: true });
  }
}
