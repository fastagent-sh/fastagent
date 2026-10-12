/**
 * `deploy railway`: no config file of its own, scale-to-zero is a manual dashboard step, the URL is minted (see
 * planRailwayDeploy).
 */
import { basename } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import { isGeneratedRailwayignore, planRailwayDeploy, toRailwayName } from "../../../deploy/railway/plan.ts";
import { deployRailwayRun } from "../../../deploy/railway/run.ts";
import { excludedRailwayContexts } from "../../../deploy/railway/upload.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { assembleSecrets } from "../../../deploy/secrets.ts";
import { type BoxShell, processShell } from "../../../deploy/box-shell.ts";
import { failStartup } from "../../fail.ts";
import { isInteractive } from "../../shared.ts";
import { type HostDeploy, boxLoginStep, registrarsFor } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const railwayHost: HostDeploy = {
  // Besides the container's, which planArtifacts owns for every host, Railway's own is its `.railwayignore`.
  isOurs: (path, content) => path.endsWith(".railwayignore") && isGeneratedRailwayignore(content),
  shell: async (agentDir) => railwayShell(toRailwayName(basename(agentDir)), agentDir),
  async deploy(ctx) {
    const { opts, agentDir, pre, channels, write } = ctx;
    const { hasCron, modelAuth, boxLogin, container, declaredSecrets, values, valueFile } = pre;
    const serviceName = toRailwayName(basename(agentDir));
    const plan = planRailwayDeploy({
      serviceName,
      boxLogin,
      channels,
      secrets: pre.secrets,
      hasCron,
      ...container,
    });
    await write(plan.artifacts, { force: !!opts.force });
    const excluded = await excludedRailwayContexts(agentDir);
    if (excluded.length > 0) {
      const issue =
        `Railway upload excludes required context files: ${excluded.join(", ")} — re-include them and their ` +
        `parent directories in .railwayignore before deploying`;
      if (opts.run) failStartup(new Error(issue));
      console.error(`[fastagent] warn: ${issue}`);
    }
    if (opts.run) {
      return runDeployRailway({
        agentDir,
        name: serviceName,
        modelAuth,
        boxLogin,
        input: opts.input !== false && isInteractive(),
        channels,
        declaredSecrets,
        values,
        valueFile,
        intoLinked: !!opts.intoLinked,
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/** `deploy railway --run`: drive the railway CLI to completion. */
async function runDeployRailway(params: {
  agentDir: string;
  name: string;
  modelAuth: string | undefined;
  /** The provider the box logs in to itself once it is up (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** A person can answer the login: `--run` continues into it rather than stopping at "not logged in". */
  input: boolean;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  values: ReadonlyMap<string, string>;
  valueFile: string;
  intoLinked: boolean;
}): Promise<void> {
  const { agentDir, name, channels, intoLinked } = params;
  const railway = spawnRunner("railway", agentDir);
  // Fail fast if the railway CLI is absent (spawn ENOENT → 127), with the install link.
  if ((await railway(["--version"], { capture: true })).code === 127) {
    failStartup(new Error(`railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run`));
  }

  const { secrets, missingSecrets } = assembleSecrets({
    modelAuth: params.modelAuth,
    declared: params.declaredSecrets,
    values: params.values,
  });

  const outcome = await deployRailwayRun(
    {
      name,
      mountPath: "/data",
      secrets,
      missingSecrets,
      valueFile: params.valueFile,
      channels,
      intoLinked,
      ...boxLoginStep("railway", params, () => railwayShell(name, agentDir)),
    },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(agentDir, params.values),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → ${outcome.url}`);
}

/** `railway ssh` into the service, in the project and environment this directory is linked to. */
function railwayShell(service: string, agentDir: string): BoxShell {
  // One quoted word: the command reaches the box as ONE line its shell parses, the way OpenSSH hands it over.
  return processShell("railway", (command) => ["ssh", "--service", service, "--", `sh -c '${command}'`], agentDir);
}
