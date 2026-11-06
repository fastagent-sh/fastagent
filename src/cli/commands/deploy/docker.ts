/** `deploy docker`: one app service + loopback port + state volume, as a user-owned Compose file. */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ownPublicUrl } from "../../../deploy/container.ts";
import {
  DOCKER_COMPOSE_FILE,
  DOCKER_VALUE_FILE,
  ingressNotes,
  isGeneratedCompose,
  planDockerDeploy,
  toDockerProjectName,
} from "../../../deploy/docker/plan.ts";
import { deployDockerRun } from "../../../deploy/docker/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { SECRET_FILE_MODE, exists } from "../../../paths.ts";
import { assembleSecrets } from "../../../deploy/secrets.ts";
import { type BoxShell, processShell } from "../../../deploy/box-shell.ts";
import { failStartup } from "../../fail.ts";
import { type Answerer, type HostDeploy, boxLoginStep, leftToPerson } from "./shared.ts";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const dockerHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith(DOCKER_COMPOSE_FILE) && isGeneratedCompose(content),
  shell: async (agentDir) => composeShell(DOCKER_COMPOSE_FILE, agentDir),
  validate({ opts, agentDir, pre }) {
    if (resolve(agentDir, pre.valueFile) !== join(agentDir, DOCKER_VALUE_FILE)) {
      const issue =
        `FASTAGENT_SECRETS_DIR points this run's values at ${pre.valueFile}, but the generated Compose reads ` +
        `${DOCKER_VALUE_FILE} (a committed artifact cannot carry this machine's path), so the ` +
        `container would start with none of them. Unset FASTAGENT_SECRETS_DIR, or put the values in that file.`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${issue}`));
      console.error(`[fastagent] warn: ${issue}`);
    }
  },
  async deploy(ctx) {
    const { opts, agentDir, channels, pre, write } = ctx;
    const { modelAuth, boxLogin, container, port, declaredSecrets, values, valueFile } = pre;
    // Compose requires its committed env_file to exist, even when no values are declared.
    const composeValueFile = join(agentDir, DOCKER_VALUE_FILE);
    await mkdir(dirname(composeValueFile), { recursive: true });
    if (!(await exists(composeValueFile))) await writeFile(composeValueFile, "", { mode: SECRET_FILE_MODE });
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
    const plan = planDockerDeploy({
      projectName: toDockerProjectName(basename(agentDir)),
      port,
      boxLogin,
      channels,
      secrets: pre.secrets,
      valueFile,
      ...container,
    });
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      return runDeployDocker({
        agentDir,
        composeFile: plan.composePath,
        port,
        modelAuth,
        boxLogin,
        answerer: ctx.answerer,
        channels,
        declaredSecrets,
        values,
        valueFile,
        publicUrl: ownPublicUrl(container.config),
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
  /** The provider the box logs in to itself once it is up (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** Who answers the box's login: `--run` continues into it rather than stopping at "not logged in". */
  answerer: Answerer;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  values: ReadonlyMap<string, string>;
  valueFile: string;
  /** The `http.publicUrl` the configuration names: where the agent points its own webhook channels. */
  publicUrl: string | undefined;
}): Promise<string | undefined> {
  const { agentDir, composeFile, port, channels } = params;
  const leave = leftToPerson(params.answerer);
  const { secrets, missingSecrets } = assembleSecrets({
    modelAuth: params.modelAuth,
    declared: params.declaredSecrets,
    values: params.values,
  });
  const outcome = await deployDockerRun(
    {
      composeFile,
      port,
      secrets,
      missingSecrets,
      valueFile: params.valueFile,
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
