/** `deploy docker`: one app service + loopback port + state volume, as a user-owned Compose file. */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { webhookPaths } from "../../../deploy/channel-ingress.ts";
import {
  composeHasTunnelService,
  isGeneratedCompose,
  planDockerDeploy,
  toDockerProjectName,
} from "../../../deploy/docker/plan.ts";
import { deployDockerRun } from "../../../deploy/docker/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { openExternalUrl } from "../../../open-url.ts";
import {
  type ResolvedPlacement,
  SECRETS_DIRNAME,
  SECRET_FILE_MODE,
  exists,
  readTextIfExists,
  resolveStateRoot,
} from "../../../paths.ts";
import { dotEnvPath } from "../../../env.ts";
import { announceWebhooks } from "../../../tunnel.ts";
import { failStartup } from "../../fail.ts";
import { type HostDeploy, carryCredentials } from "./shared.ts";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const dockerHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith("fastagent.compose.yml") && isGeneratedCompose(content),
  async deploy(ctx) {
    const { opts, agentDir, workspace, channels, webhookChannels, pre, write } = ctx;
    const { modelAuth, modelKeyInDefinition, authPath, container, port, extraSecrets, values, valueFile } = pre;
    // The generated Compose names `<agent>/.secrets/.env` unconditionally, so it has to be there — Compose refuses
    // an `env_file` entry pointing at a missing path, and this floor predates `required: false` (Compose 2.24).
    // Creating it empty is honest: a deployment that declares nothing declares it in an empty file.
    const composeValueFile = join(agentDir, SECRETS_DIRNAME, ".env");
    await mkdir(dirname(composeValueFile), { recursive: true });
    if (!(await exists(composeValueFile))) await writeFile(composeValueFile, "", { mode: SECRET_FILE_MODE });
    // The pre-flight read whatever `FASTAGENT_SECRETS_DIR` resolved to; the committed Compose cannot, because a
    // builder's path would not mean the same thing anywhere else. Under `--run` the two files disagreeing is a
    // DETERMINISTIC failure and gates like every other one: the missing-values gate would pass on the file this
    // machine reads while `compose up` starts a container whose declared secrets and model are all absent.
    if (resolve(dotEnvPath(agentDir)) !== resolve(composeValueFile)) {
      const issue =
        `FASTAGENT_SECRETS_DIR points this run's values at ${valueFile}, but the generated Compose reads ` +
        `${relative(workspace, composeValueFile)} (a committed artifact cannot carry this machine's path), so the ` +
        `container would start with none of them. Unset FASTAGENT_SECRETS_DIR, or put the values in that file.`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${issue}`));
      console.error(`[fastagent] warn: ${issue}`);
    }
    // Compose interpolates `$VAR` INSIDE env_file values (`format: raw` needs Compose 2.30), so a credential
    // containing `$` reaches the container rewritten — silently, and differently from what this pre-flight read.
    // No escaping advice: this ONE file is also read literally by `dev`/`start` (`parseEnvContent`) and pushed
    // as-is by every other host, so `$$` would fix Docker by corrupting all of them.
    const dollarValues = [...values].filter(([, value]) => value.includes("$")).map(([name]) => name);
    if (dollarValues.length > 0) {
      console.error(
        `[fastagent] warn: ${dollarValues.join(", ")} contain "$", which Compose expands when reading ${valueFile} ` +
          `(an undefined name becomes empty), so the container sees a different value. "$$" escapes it for Compose ` +
          `ONLY — \`fastagent dev\`/\`start\` and the other hosts read this file literally and would keep the extra ` +
          `"$". Prefer a value without "$".`,
      );
    }
    const hasDeclaredChannels = channels.length > 0;
    const projectName = toDockerProjectName(basename(workspace));
    const dockerPlan = (tunnel: boolean) =>
      planDockerDeploy({
        projectName,
        port,
        modelAuth,
        channels,
        tunnel,
        extraSecrets,
        valueFile,
        ...container,
      });
    const requestedTunnel = !!opts.tunnel && (!hasDeclaredChannels || webhookChannels.length > 0);
    if (opts.tunnel && hasDeclaredChannels && webhookChannels.length === 0) {
      console.error(`[fastagent] note: --tunnel skipped — every channel uses a long connection`);
    }
    let plan = dockerPlan(requestedTunnel);
    // An existing Compose file is authoritative: shape its comparison/runbook from the topology on disk, regardless
    // of the current flag.
    const composeFile = join(workspace, plan.composePath);
    let keptWithoutRequestedTunnel = false;
    // Same ownership question as fly.toml: a hand-owned compose file survives --force, so the plan must describe the
    // topology that will actually be there.
    const composeText = await readTextIfExists(composeFile).catch(failStartup);
    if (composeText !== undefined && (!opts.force || !isGeneratedCompose(composeText))) {
      const existingHasTunnel = composeHasTunnelService(composeText);
      plan = dockerPlan(existingHasTunnel);
      keptWithoutRequestedTunnel = requestedTunnel && !existingHasTunnel;
    }
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      return runDeployDocker({
        agentDir,
        workspace,
        composeFile: plan.composePath,
        port,
        requireTunnel: requestedTunnel,
        modelAuth,
        modelKeyInDefinition,
        authPath,
        channels,
        extraSecrets,
        values,
        valueFile,
      });
    }
    if (keptWithoutRequestedTunnel) {
      console.error(
        `[fastagent] warn: --tunnel was requested but kept ${plan.composePath} has no "tunnel" service — ` +
          `edit it, delete it and regenerate, or pass --force`,
      );
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/**
 * `deploy docker --run`: carry local credentials into Compose's child environment, then reconcile the user-owned local
 * topology.
 */
async function runDeployDocker(
  params: ResolvedPlacement & {
    composeFile: string;
    port: number;
    requireTunnel: boolean;
    modelAuth: string | undefined;
    modelKeyInDefinition: boolean;
    authPath: string;
    channels: readonly DeclaredChannel[];
    extraSecrets: readonly DeclaredSecret[];
    values: ReadonlyMap<string, string>;
    valueFile: string;
  },
): Promise<void> {
  const { agentDir, workspace, composeFile, port, requireTunnel, channels } = params;
  const { secrets, missingSecrets, needsModelCredential } = await carryCredentials(params);
  const outcome = await deployDockerRun(
    {
      composeFile,
      port,
      secrets,
      missingSecrets,
      valueFile: params.valueFile,
      needsModelCredential,
      requireTunnel,
      announce: (tunnelUrl) =>
        announceWebhooks(agentDir, tunnelUrl, channels, {
          openUrl: openExternalUrl,
          stateRoot: resolveStateRoot(agentDir),
        }),
    },
    spawnRunner("docker", workspace),
    (message) => console.error(`[fastagent] ${message}`),
  );
  const compose = `docker compose -f ${composeFile}`;
  // Compose reached "up" iff the driver could report where it is.
  const isUp = outcome.ok || outcome.url !== undefined || outcome.tunnelUrl !== undefined;
  if (outcome.url) console.error(`[fastagent] running → ${outcome.url}`);
  if (isUp) {
    console.error(`[fastagent] logs: ${compose} logs -f agent`);
    console.error(`[fastagent] stop: ${compose} down (state volume is kept)`);
  }
  // BEFORE failStartup: a registration gate says "re-run this deploy", and a re-run rebuilds the tunnel service.
  if (outcome.tunnelUrl) {
    console.error(
      `[fastagent] note: Quick Tunnel URLs are ephemeral — after the tunnel container/Docker daemon ` +
        `restarts, re-run this deploy so webhooks receive the new URL`,
    );
  }
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  if (outcome.tunnelUrl) return;
  const paths = webhookPaths(channels);
  if (paths.length > 0) {
    console.error(
      `[fastagent] note: public ingress is operator-owned — configure your tunnel/proxy, then wire the ` +
        `default webhook path(s): ${paths.join(", ")} (or your remapped channel routes)`,
    );
  }
}
