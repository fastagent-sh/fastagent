/** `deploy docker`: one app service + loopback port + state volume, as a user-owned Compose file. */
import { basename, join } from "node:path";
import { webhookPaths } from "../../../deploy/channel-ingress.ts";
import {
  composeHasTunnelService,
  composeInterpolatedNames,
  isGeneratedCompose,
  planDockerDeploy,
  toDockerProjectName,
} from "../../../deploy/docker/plan.ts";
import { deployDockerRun } from "../../../deploy/docker/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { openExternalUrl } from "../../../open-url.ts";
import { type ResolvedPlacement, readTextIfExists, resolveStateRoot } from "../../../paths.ts";
import { announceWebhooks } from "../../../tunnel.ts";
import { failStartup } from "../../fail.ts";
import { type HostDeploy, carryCredentials } from "./shared.ts";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const dockerHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith("fastagent.compose.yml") && isGeneratedCompose(content),
  async deploy(ctx) {
    const { opts, agentDir, workspace, channels, webhookChannels, pre, write } = ctx;
    const {
      modelAuth,
      modelKeyInDefinition,
      authPath,
      container,
      port,
      extraSecrets,
      values,
      valueFile,
      valueFileExists,
    } = pre;
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
        valueFileExists,
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
  const { agentDir, workspace, composeFile, port, requireTunnel, channels, modelAuth, extraSecrets } = params;
  const { secrets, missingSecrets, needsModelCredential } = await carryCredentials(params);
  const outcome = await deployDockerRun(
    {
      composeFile,
      interpolated: composeInterpolatedNames({ modelAuth, channels, extraSecrets }),
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
