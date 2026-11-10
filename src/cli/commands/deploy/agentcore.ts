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
  PROBE_PAYLOAD,
  ingressSessionId,
  isGeneratedAgentcoreTemplate,
  planAgentcoreDeploy,
} from "../../../deploy/agentcore/plan.ts";
import { deployAgentcoreRun, pickStackOutputs } from "../../../deploy/agentcore/run.ts";
import { awsCli, awsJson } from "../../../deploy/agentcore/aws-cli.ts";
import { agentcoreShell } from "../../../deploy/agentcore/shell.ts";
import { awsRunner, spawnRunner } from "../../../deploy/runner.ts";
import { SECRET_FILE_MODE, exists } from "../../../paths.ts";
import { deploySecrets } from "./secrets-step.ts";
import { IDLE_TIMEOUT_BOUNDS } from "../../../harnesses/pi-durable/config.ts";
import { failStartup, failUsage } from "../../fail.ts";
import { shellArg } from "../../shared.ts";
import { ownPublicUrl } from "../../../deploy/container.ts";
import { type Answerer, type HostDeploy, boxLoginStep, registrarsFor, urlRecorder } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";
import type { DeploymentApi } from "../../../deploy/api.ts";
import type { ModelKey } from "../../../deploy/secrets.ts";

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
  validate({ opts, agentDir, pre }) {
    idleTimeoutOf(opts);
    const longConnectionChannels = pre.channels.filter((channel) => channel.ingress === "long-connection");
    if (longConnectionChannels.length > 0) {
      const msg =
        `long-connection channel (${longConnectionChannels.map((c) => c.name).join(", ")}) cannot run on AgentCore — there is no ` +
        `resident process to hold the connection, and nothing wakes a reclaimed session. Switch the channel ` +
        `to webhook mode (its events then ride the forwarder like every other channel).`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg}`);
    }
    const name = agentcoreName(basename(agentDir));
    // The forwarder Lambda name embeds this name and must fit AWS's 64-character limit.
    if (name.length > 40) {
      failStartup(
        new Error(
          `deploy stopped: the directory name maps to "${name}" (${name.length} chars) — AWS resource ` +
            `names derived from it exceed their limits past 40 chars. Deploy from a shorter directory name.`,
        ),
      );
    }
  },
  async deploy(ctx) {
    const { opts, agentDir, config, channels, pre, write } = ctx;
    const { modelAuth, boxLogin, container, declaredSecrets, values, valueFile } = pre;
    if (boxLogin) {
      console.error(
        `[fastagent] note: AgentCore resets the runtime's storage on every deploy AND after 14 idle days, and the ` +
          `${boxLogin} login with it: every deploy of this agent ends with a login on the runtime, and after an idle ` +
          `reset every turn fails until \`fastagent login ${boxLogin} --deployment agentcore\` (the runtime's log says ` +
          `so). For an agent that must keep answering unattended, set ${boxLogin}'s API key with \`fastagent secrets set agentcore <its variable>\`.`,
      );
    }
    // Schedules and wake-ups need nothing from the template beyond the forwarder every stack has: the container
    // mirrors them into EventBridge schedules itself (schedule/wake-alarm.ts). A schedule that does not build is the
    // pre-flight's to report.
    const acName = agentcoreName(basename(agentDir));
    const plan = planAgentcoreDeploy({
      name: acName,
      boxLogin,
      channels,
      secrets: pre.secrets,
      idleTimeoutSeconds: idleTimeoutOf(opts) ?? config.deploy?.agentcore?.idleTimeoutSeconds,
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
      await runDeployAgentcore({
        agentDir,
        name: acName,
        modelAuth,
        boxLogin,
        answerer: ctx.answerer,
        rerun: ctx.rerun,
        channels,
        declaredSecrets,
        modelKey: pre.modelKey,
        api: ctx.api,
        values,
        valueFile,
        topology: plan.topology,
        publicUrl: ownPublicUrl(container.config),
        config: opts.config,
      });
      return undefined;
    }
    console.log(plan.runbook.join("\n"));
    return undefined;
  },
};

/** `deploy agentcore --run`: drive aws + docker to completion. */
async function runDeployAgentcore(params: {
  agentDir: string;
  name: string;
  modelAuth: string | undefined;
  /** The provider the runtime logs in to itself once it is verified (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** Who answers the box's login: `--run` continues into it rather than stopping at "not logged in". */
  answerer: Answerer;
  /** The command that runs this deploy again (`DeployContext.rerun`). */
  rerun: string;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  modelKey: ModelKey;
  api: DeploymentApi;
  values: ReadonlyMap<string, string>;
  valueFile: string;
  topology: AgentcoreTopology;
  /** The `http.publicUrl` the configuration names, where the platforms reach the runtime instead of the forwarder. */
  publicUrl: string | undefined;
  /** The `--config` file, where a URL a person set is recorded once the runtime confirms it. */
  config: string | undefined;
}): Promise<void> {
  const { agentDir, name, channels, topology } = params;
  const secretsStep = deploySecrets({
    host: "agentcore",
    label: "AWS Secrets Manager",
    agentDir,
    opts: { config: params.config },
    answerer: params.answerer,
    api: params.api,
    modelAuth: params.modelAuth,
    modelKey: params.modelKey,
    declaredSecrets: params.declaredSecrets,
    valueFile: params.valueFile,
    values: params.values,
  });
  // The model's key on the target is a credential like a key in the value file: the runtime has it from its first
  // invocation, so there is no login to run on the box. Only the target can say, hence after the secrets step.
  let keyOnTarget = false;
  const login = boxLoginStep("agentcore", params, (runtimeArn: string) =>
    agentcoreShell(runtimeArn, ingressSessionId(name), awsRunner(agentDir)),
  ).boxLogin;
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
        provideSecrets: async (store) => {
          const gate = await secretsStep(store);
          if (gate !== undefined) return gate;
          const held = await store.names();
          keyOnTarget = params.modelKey.variables.some((variable) => held.has(variable));
          // Decided before the build and the stack: the deploy resets the runtime's storage and the login with it, so
          // with nobody to log it in again it would end at "not logged in" AFTER replacing a runtime that was serving,
          // with the webhooks a previous deploy registered still pointing at it. A coding agent's ticket has someone:
          // its user.
          if (params.boxLogin && !keyOnTarget && params.answerer.kind === "nobody") {
            return (
              `every AgentCore deploy wipes the runtime's ${params.boxLogin} login, and without a terminal ` +
              `nobody can log it in again — run this deploy in a terminal; from a coding agent, run ` +
              `\`${params.rerun} --json\`, which hands the login to its user; or set ` +
              `${params.boxLogin}'s API key with \`fastagent secrets set agentcore ${params.modelKey.variables[0] ?? "<its variable>"}\``
            );
          }
          return undefined;
        },
        // The wake-alarm shared secret (container ↔ forwarder).
        wakeSecret: crypto.randomUUID(),
        // The forwarder→runtime ingress secret: what makes an envelope the forwarder's rather than any IAM principal's.
        ingressSecret: crypto.randomUUID(),
        channels,
        topology,
        ...(params.publicUrl === undefined ? {} : { publicUrl: params.publicUrl }),
        ...urlRecorder(agentDir, params.config, params.values, params.answerer),
        ...(login === undefined
          ? {}
          : {
              boxLogin: {
                ...login,
                run: async (runtimeArn: string) => (keyOnTarget ? undefined : login.run(runtimeArn)),
              },
            }),
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
      registrarsFor(params.values, params.answerer),
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
      `[fastagent] probe: aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn ${outcome.runtimeArn} \\\n` +
        `  --runtime-session-id "${ingressSessionId(name)}" \\\n` +
        `  --payload '${PROBE_PAYLOAD}' --cli-binary-format raw-in-base64-out /dev/stdout`,
    );
  } finally {
    await rm(paramsDir, { recursive: true, force: true });
  }
}

/** `--idle-timeout`, whole seconds within AWS's bounds; refused otherwise, before anything is built. */
function idleTimeoutOf({ idleTimeout }: { idleTimeout?: string }): number | undefined {
  if (idleTimeout === undefined) return undefined;
  const seconds = Number(idleTimeout);
  const { minimum, maximum } = IDLE_TIMEOUT_BOUNDS;
  if (!/^\d+$/.test(idleTimeout) || seconds < minimum || seconds > maximum) {
    failUsage(`--idle-timeout must be a whole number of seconds from ${minimum} to ${maximum}, got "${idleTimeout}"`);
  }
  return seconds;
}
