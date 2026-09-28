/**
 * `deploy railway`: a thin config file, scale-to-zero is a manual dashboard step, the URL is minted (see
 * planRailwayDeploy).
 */
import { basename } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  dockerfilePathVar,
  isGeneratedRailwayJson,
  planRailwayDeploy,
  toRailwayName,
} from "../../../deploy/railway/plan.ts";
import { deployRailwayRun } from "../../../deploy/railway/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import type { ResolvedPlacement } from "../../../paths.ts";
import { assembleSecrets } from "../../../deploy/secrets.ts";
import type { BoxShell } from "../../box-login.ts";
import { failStartup } from "../../fail.ts";
import { isInteractive } from "../../shared.ts";
import { type HostDeploy, boxLoginStep, registrarsFor } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const railwayHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith("railway.json") && isGeneratedRailwayJson(content),
  artifact: "railway.json",
  shell: async ({ workspace }) => railwayShell(toRailwayName(basename(workspace))),
  async deploy(ctx) {
    const { opts, agentDir, workspace, pre, channels, write } = ctx;
    const { hasCron, modelAuth, boxLogin, container, declaredSecrets, values, valueFile } = pre;
    const serviceName = toRailwayName(basename(workspace));
    const plan = planRailwayDeploy({
      serviceName,
      boxLogin,
      channels,
      secrets: pre.secrets,
      hasCron,
      ...container,
    });
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      // The BUILD entry is guaranteed by the RAILWAY_DOCKERFILE_PATH service variable the runner sets (Railway's
      // documented non-root-Dockerfile route), and Railway's default restart policy already equals the file's
      // ON_FAILURE — the dashboard-only Config-as-code pointer only adds the /health deploy gate (boot-crash
      // visibility), so it is an OPTIONAL note, not a gate.
      console.error(
        `[fastagent] note: optional — point the service at fastagent/railway.json (Service → Settings → ` +
          `Config-as-code, dashboard-only) so the /health healthcheck marks a boot-crashing deploy as FAILED; ` +
          `the build already uses fastagent/Dockerfile via the RAILWAY_DOCKERFILE_PATH variable`,
      );
      return runDeployRailway({
        agentDir,
        workspace,
        name: serviceName,
        modelAuth,
        boxLogin,
        input: opts.input !== false && isInteractive(),
        channels,
        declaredSecrets,
        values,
        valueFile,
        intoLinked: !!opts.intoLinked,
        dockerfilePath: dockerfilePathVar(pre.container.agentPrefix),
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/** `deploy railway --run`: drive the railway CLI to completion. */
async function runDeployRailway(
  params: ResolvedPlacement & {
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
    /** RAILWAY_DOCKERFILE_PATH — the scriptable route to the agent's non-root Dockerfile. */
    dockerfilePath: string;
  },
): Promise<void> {
  const { agentDir, workspace, name, channels, intoLinked, dockerfilePath } = params;
  const railway = spawnRunner("railway", workspace);
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
      dockerfilePath,
      ...boxLoginStep("railway", params, railwayShell(name)),
    },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(agentDir),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → ${outcome.url}`);
}

/** `railway ssh` into the service, in the project and environment this directory is linked to. */
function railwayShell(service: string): BoxShell {
  // One quoted word: the command reaches the box as ONE line its shell parses, the way OpenSSH hands it over.
  return { bin: "railway", args: (command) => ["ssh", "--service", service, "--", `sh -c '${command}'`] };
}
