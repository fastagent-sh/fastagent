/** `deploy docker`: one app service + loopback port + state volume, as a user-owned Compose file. */
import { ownPublicUrl } from "../../../deploy/delivery.ts";
import {
  dockerComposeFile,
  isDockerComposePath,
  composeValuesGate,
  ingressNotes,
  isGeneratedCompose,
  planDockerDeploy,
  toDockerProjectName,
} from "../../../deploy/docker/plan.ts";
import { deployDockerRun } from "../../../deploy/docker/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { API_KEY_VARIABLE } from "../../../http/server.ts";
import { type BoxShell, processShell } from "../../../deploy/box-shell.ts";
import type { DeploymentApi } from "../../../deploy/api.ts";
import { type ModelKey, declaredNames, secretNeeds } from "../../../deploy/secrets.ts";
import { failStartup } from "../../fail.ts";
import { type Answerer, type HostDeploy, boxLoginStep, leftToPerson } from "./shared.ts";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

/**
 * What Compose is given: this command's environment, which the file `--env-file` names is already laid into. It is
 * Docker's only source, whatever `--from-env` says (that flag decides what `deploy` itself reads for a store), since
 * Compose has no other place to take a value from.
 */
const COMPOSE_ENVIRONMENT = (): NodeJS.ProcessEnv => process.env;
const COMPOSE_SOURCE = "the environment this command runs in (and --env-file)";

export const dockerHost: HostDeploy = {
  isOurs: (path, content) => isDockerComposePath(path) && isGeneratedCompose(content),
  legacyManifest: { file: "fastagent.compose.yml", generated: isGeneratedCompose, renamed: dockerComposeFile },
  shell: async (agentDir, name) => composeShell(dockerComposeFile(name), agentDir),
  async deploy(ctx) {
    const { opts, agentDir, name, channels, pre, write } = ctx;
    const { modelAuth, boxLogin, container, port, declaredSecrets } = pre;
    // What Compose is told to fill from its environment: the declared names, the model's key only when the deploy was
    // given one (`modelAuth`) or the provider has no login to fall back on (a need), and the Agent API's key. Not every
    // variable a provider reads: a key exported in the shell for other tools would otherwise ride into a container that
    // is about to log in, and into `docker inspect`.
    const secretNames = [
      ...new Set([
        ...declaredNames(modelAuth, declaredSecrets),
        ...secretNeeds(modelAuth, declaredSecrets, pre.modelKey).map((need) => need.name),
        ...(ctx.api.served ? [API_KEY_VARIABLE] : []),
      ]),
    ];
    const plan = planDockerDeploy({
      projectName: toDockerProjectName(name),
      port,
      boxLogin,
      channels,
      secrets: pre.secrets,
      secretNames,
      ...container,
    });
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      return runDeployDocker({
        agentDir,
        composeFile: plan.composePath,
        port,
        modelAuth,
        modelKey: pre.modelKey,
        boxLogin,
        answerer: ctx.answerer,
        api: ctx.api,
        channels,
        declaredSecrets,
        publicUrl: ownPublicUrl(container.config),
        config: opts.config,
        envFile: opts.envFile,
      });
    }
    console.log(plan.runbook.join("\n"));
    return `http://127.0.0.1:${port}`;
  },
};

/** `deploy docker --run`: reconcile the user-owned local topology, then log the box in if it must. */
async function runDeployDocker(params: {
  agentDir: string;
  composeFile: string;
  port: number;
  modelAuth: string | undefined;
  modelKey: ModelKey;
  /** The provider the box logs in to itself once it is up (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** Who answers the box's login: `--run` continues into it rather than stopping at "not logged in". */
  answerer: Answerer;
  api: DeploymentApi;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  /** The `http.publicUrl` the configuration names: where the agent points its own webhook channels. */
  publicUrl: string | undefined;
  /** The `--config` file, named by the commands a gate suggests. */
  config: string | undefined;
  /** The `--env-file` the values come from, when one was named. */
  envFile: string | undefined;
}): Promise<string | undefined> {
  const { agentDir, composeFile, port, channels } = params;
  const leave = leftToPerson(params.answerer);
  const needs = secretNeeds(params.modelAuth, params.declaredSecrets, params.modelKey);
  const outcome = await deployDockerRun(
    {
      composeFile,
      port,
      checkValues: () => composeValuesGate(needs, COMPOSE_ENVIRONMENT(), COMPOSE_SOURCE),
      ...boxLoginStep("docker", params, () => composeShell(composeFile, agentDir)),
    },
    spawnRunner("docker", agentDir),
    (message) => console.error(`[fastagent] ${message}`),
  );
  const compose = `docker compose -f ${composeFile}`;
  // Compose reached "up" iff the driver could report where it is.
  const isUp = outcome.ok || outcome.url !== undefined;
  if (outcome.url) console.error(`[fastagent] running → ${outcome.url}`);
  if (isUp) {
    console.error(`[fastagent] logs: ${compose} logs -f agent`);
    console.error(`[fastagent] stop: ${compose} down (state volume is kept)`);
  }
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  for (const note of ingressNotes(channels, params.publicUrl, outcome.url && `${outcome.url}/health`)) {
    console.error(`[fastagent] note: ${note}`);
    leave?.(note);
  }
  return outcome.url;
}

/** `docker compose exec` into the running agent service. */
function composeShell(composeFile: string, agentDir: string): BoxShell {
  return processShell(
    "docker",
    (command) => ["compose", "-f", composeFile, "exec", "-T", "agent", "sh", "-c", command],
    agentDir,
  );
}
