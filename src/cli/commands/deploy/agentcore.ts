/**
 * `deploy agentcore`: one CloudFormation stack (runtime + forwarder Lambda + EventBridge schedules);
 * no public URL and no resident process — see deploy/agentcore/plan.ts for the topology decisions.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_WEBHOOK_BODY_BYTES } from "../../../channels/agentcore-limits.ts";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  FORWARDER_FILE,
  TEMPLATE_FILE,
  agentcoreName,
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
    const { opts, agentDir, workspace, config, channels, webhookChannels, longConnectionChannels, pre, write } = ctx;
    const { modelAuth, modelKeyInDefinition, authPath, container, extraSecrets } = pre;
    // Long-connection channels are STRUCTURALLY unsupported: the connection is the ingress, and a
    // reclaimed session has nothing to wake it — events in the gap are silently lost. `--run` gates
    // (deploying a channel that can't connect); generate-only warns and prints the runbook.
    if (longConnectionChannels.length > 0) {
      const msg =
        `long-connection channel (${longConnectionChannels.map((c) => c.name).join(", ")}) cannot run on AgentCore — there is no ` +
        `resident process to hold the connection, and nothing wakes a reclaimed session. Switch the channel ` +
        `to webhook mode (its events then ride the forwarder like every other channel).`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg}`);
    }
    // selfSchedule is fully supported: pending wake-ups are mirrored into one-shot EventBridge
    // schedules via the forwarder (the wake-alarm mechanism — see deploy/agentcore/plan.ts).
    // Schedules feed EventBridge rules — parsed facts (cron/tz), not just file names, so a bad file
    // must surface here (a schedule silently missing its rule would never fire).
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
    // (`fastagent-<name>-forwarder` ≤ 64 chars). Gate the base instead of silently truncating —
    // truncation would break the redeploy identity (a renamed stack starts blank state).
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
      // Same discipline as Fly's kept-toml time-trigger gate: a deploy whose schedule silently never
      // fires is worse than a stopped deploy — nothing fails visibly when the instant passes.
      const msg = `schedule "${u.name}" cannot be expressed as an EventBridge rule — ${u.reason}`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg} — it will NOT fire on this deployment`);
    }
    // Host capability limit, stated at plan time. GitHub's own webhook contract is 25 MiB, but a
    // Lambda Function URL request caps at 6 MB — so on this host a large payload cannot arrive at
    // all. Better a sentence here than an opaque 502 the first time someone pushes a big diff.
    if (channels.some((channel) => channel.name === "github")) {
      console.error(
        `[fastagent] note: on AgentCore a webhook body is capped at ~${Math.round(MAX_WEBHOOK_BODY_BYTES / (1 << 20))} MiB ` +
          `(the forwarder's Function URL limit); the GitHub channel accepts 25 MiB on a resident host, so the largest ` +
          `payloads are rejected here rather than delivered`,
      );
    }
    // The template IS the topology (EventBridge rules, wake wiring, secrets) — a kept generated
    // template that no longer matches the definition would deploy a stack silently missing the
    // difference (a new schedule with no rule never fires: the exact miss the gate above stops).
    // A hand-written template (marker removed) is the operator's own — kept, never gated.
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
        selfSchedule: !!config.selfSchedule,
        // Same predicate the template uses for the forwarder resource — kept in one expression so
        // the run path and the topology cannot disagree about whether a forwarder exists.
        needsForwarder: webhookChannels.length > 0 || loaded.schedules.length > 0 || !!config.selfSchedule,
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/**
 * `deploy agentcore --run`: drive aws + docker to completion. Mirrors the fly driver — same
 * credential carry via {@link carryCredentials}, same runner seam (spawned `aws` + `docker`, cwd = the
 * workspace so the build context is the agent). The AgentCore-specific sequence (identity → buildx →
 * ECR → CloudFormation → outputs → webhooks) lives in {@link deployAgentcoreRun}; the params temp
 * file (secret values off argv) is created here — 0600, removed after the run either way.
 */
async function runDeployAgentcore(
  params: ResolvedPlacement & {
    agentPrefix: string;
    name: string;
    modelAuth: string | undefined;
    modelKeyInDefinition: boolean;
    authPath: string;
    channels: readonly DeclaredChannel[];
    extraSecrets: string[];
    selfSchedule: boolean;
    needsForwarder: boolean;
  },
): Promise<void> {
  const { agentDir, workspace, agentPrefix, name, channels, selfSchedule } = params;
  const { secrets, missingSecrets, needsModelCredential } = await carryCredentials(params);
  // The wake-alarm shared secret (container ↔ forwarder). Minted fresh each run — both sides receive
  // the SAME parameter, so rotation is atomic; it never needs to be remembered locally.
  if (selfSchedule) secrets.FASTAGENT_WAKE_SECRET = crypto.randomUUID();
  // The forwarder→runtime ingress secret: what makes an envelope the forwarder's rather than any IAM
  // principal's. Minted fresh each run — both sides receive the SAME parameter, so rotation is atomic.
  if (params.needsForwarder) secrets.FASTAGENT_INGRESS_SECRET = crypto.randomUUID();
  gateOnModelCredential(needsModelCredential);
  // The params temp dir holds the ONE file carrying secret values (file:// parameter-overrides —
  // never argv); 0700/0600 and removed after the run, success or gate.
  const paramsDir = await mkdtemp(join(tmpdir(), "fastagent-agentcore-"));
  try {
    const outcome = await deployAgentcoreRun(
      {
        name,
        templatePath: `${agentPrefix}${TEMPLATE_FILE}`,
        dockerfilePath: agentPrefix ? `${agentPrefix}Dockerfile` : undefined,
        tag: new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, "")
          .slice(0, 14),
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        secrets,
        missingSecrets,
        channels,
        // Same predicate the template uses: the forwarder exists for route channels, cron schedules
        // or selfSchedule — and it is what mints the state snapshot's presigned URLs.
        needsForwarder: params.needsForwarder,
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
    if (params.needsForwarder) {
      console.error(`[fastagent] forwarder logs → fastagent logs agentcore ${logsDir} --source forwarder --follow`);
    }
    console.error(
      `[fastagent] invoke: aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn ${outcome.runtimeArn} \\\n` +
        `  --runtime-session-id "my-conversation-000000000000000000" \\\n` +
        `  --payload '{"kind":"invoke","session":"cli","text":"hello"}' --cli-binary-format raw-in-base64-out /dev/stdout`,
    );
  } finally {
    await rm(paramsDir, { recursive: true, force: true });
  }
}
