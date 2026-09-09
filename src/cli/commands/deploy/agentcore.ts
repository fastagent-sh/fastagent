/**
 * `deploy agentcore`: one CloudFormation stack (runtime + forwarder Lambda + EventBridge schedules); no public URL and
 * no resident process.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_WEBHOOK_BODY_BYTES } from "../../../channels/agentcore-limits.ts";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  type AgentcoreTopology,
  FORWARDER_FILE,
  TEMPLATE_FILE,
  agentcoreName,
  ingressSessionId,
  isGeneratedAgentcoreTemplate,
  planAgentcoreDeploy,
} from "../../../deploy/agentcore/plan.ts";
import { deployAgentcoreRun } from "../../../deploy/agentcore/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { type ResolvedPlacement, exists } from "../../../paths.ts";
import { loadSchedules } from "../../../schedule/discover.ts";
import { failStartup } from "../../fail.ts";
import { type HostDeploy, carryCredentials, gateOnModelCredential, registrarsFor } from "./shared.ts";

/** A copy/paste-safe POSIX shell argument for the command hints deploy prints. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const agentcoreHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith(TEMPLATE_FILE) && isGeneratedAgentcoreTemplate(content),
  async deploy(ctx) {
    const { opts, agentDir, workspace, config, channels, longConnectionChannels, pre, write } = ctx;
    const { modelAuth, modelKeyInDefinition, authPath, container, extraSecrets } = pre;
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
    // selfSchedule is fully supported: pending wake-ups are mirrored into one-shot EventBridge schedules via the
    // forwarder (the wake-alarm mechanism — see deploy/agentcore/plan.ts).
    const loaded = await loadSchedules(agentDir).catch(failStartup);
    if (loaded.failures.length > 0) {
      failStartup(
        new Error(
          `deploy stopped: cannot load schedules: ${loaded.failures.map((x) => `${x.label}: ${x.message}`).join("; ")}`,
        ),
      );
    }
    const acName = agentcoreName(basename(workspace));
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
      modelAuth,
      channels,
      extraSecrets,
      schedules: loaded.schedules.map((s) => ({ name: s.name, cron: s.cron, tz: s.tz })),
      selfSchedule: !!config.selfSchedule,
      ...container,
    });
    for (const u of plan.untranslatableSchedules) {
      // Same discipline as Fly's kept-toml time-trigger gate: a deploy whose schedule silently never fires is worse
      // than a stopped deploy.
      const msg = `schedule "${u.name}" cannot be expressed as an EventBridge rule — ${u.reason}`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg} — it will NOT fire on this deployment`);
    }
    // Host capability limit, stated at plan time.
    if (channels.some((channel) => channel.name === "github")) {
      console.error(
        `[fastagent] note: on AgentCore a webhook body is capped at ~${Math.round(MAX_WEBHOOK_BODY_BYTES / (1 << 20))} MiB ` +
          `(the forwarder's Function URL limit); the GitHub channel accepts 25 MiB on a resident host, so the largest ` +
          `payloads are rejected here rather than delivered`,
      );
    }
    // The template IS the topology (EventBridge rules, wake wiring, secrets).
    const templateArtifact = plan.artifacts.find((a) => a.path.endsWith(TEMPLATE_FILE));
    const templateHome = join(workspace, templateArtifact?.path ?? TEMPLATE_FILE);
    if (!opts.force && templateArtifact && (await exists(templateHome))) {
      const existing = await readFile(templateHome, "utf8");
      if (isGeneratedAgentcoreTemplate(existing) && existing !== templateArtifact.content) {
        const msg =
          `${templateArtifact.path} no longer matches this definition (channels/schedules/selfSchedule changed) — ` +
          `the kept template would silently drop the difference. Pass --force to regenerate (hand edits are lost), ` +
          `or delete the file.`;
        if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
        console.error(`[fastagent] warn: ${msg}`);
      }
    }
    await write(plan.artifacts, {
      force: !!opts.force,
      alwaysWrite: [`${container.agentPrefix}${FORWARDER_FILE}`],
    });
    if (opts.run) {
      return runDeployAgentcore({
        agentDir,
        workspace,
        agentPrefix: container.agentPrefix,
        name: acName,
        modelAuth,
        modelKeyInDefinition,
        authPath,
        channels,
        extraSecrets,
        topology: plan.topology,
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/** `deploy agentcore --run`: drive aws + docker to completion. */
async function runDeployAgentcore(
  params: ResolvedPlacement & {
    agentPrefix: string;
    name: string;
    modelAuth: string | undefined;
    modelKeyInDefinition: boolean;
    authPath: string;
    channels: readonly DeclaredChannel[];
    extraSecrets: string[];
    topology: AgentcoreTopology;
  },
): Promise<void> {
  const { agentDir, workspace, agentPrefix, name, channels, topology } = params;
  const { secrets, missingSecrets, needsModelCredential } = await carryCredentials(params);
  // The wake-alarm shared secret (container ↔ forwarder).
  if (topology.wakeAlarms) secrets.FASTAGENT_WAKE_SECRET = crypto.randomUUID();
  // The forwarder→runtime ingress secret: what makes an envelope the forwarder's rather than any IAM principal's.
  if (topology.forwarder) secrets.FASTAGENT_INGRESS_SECRET = crypto.randomUUID();
  gateOnModelCredential(needsModelCredential);
  // The params temp dir holds the ONE file carrying secret values (file:// parameter-overrides — never argv);
  // 0700/0600 and removed after the run, success or gate.
  const paramsDir = await mkdtemp(join(tmpdir(), "fastagent-agentcore-"));
  try {
    const outcome = await deployAgentcoreRun(
      {
        name,
        templatePath: `${agentPrefix}${TEMPLATE_FILE}`,
        dockerfilePath: `${agentPrefix}Dockerfile`,
        tag: new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, "")
          .slice(0, 14),
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        secrets,
        missingSecrets,
        channels,
        topology,
      },
      spawnRunner("aws", workspace),
      spawnRunner("docker", workspace),
      (m) => console.error(`[fastagent] ${m}`),
      async (content) => {
        const path = join(paramsDir, "params.json");
        await writeFile(path, content, { mode: 0o600 });
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
    const logsDir = shellArg(workspace);
    console.error(`[fastagent] runtime logs → fastagent logs agentcore ${logsDir} --follow`);
    if (topology.forwarder) {
      console.error(`[fastagent] forwarder logs → fastagent logs agentcore ${logsDir} --source forwarder --follow`);
    }
    console.error(
      `[fastagent] invoke: aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn ${outcome.runtimeArn} \\\n` +
        `  --runtime-session-id "${ingressSessionId(name)}" \\\n` +
        `  --payload '{"kind":"invoke","session":"cli","text":"hello"}' --cli-binary-format raw-in-base64-out /dev/stdout`,
    );
  } finally {
    await rm(paramsDir, { recursive: true, force: true });
  }
}
