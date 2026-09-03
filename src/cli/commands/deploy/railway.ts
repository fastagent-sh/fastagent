/**
 * `deploy railway`: a thin config file, scale-to-zero is a manual dashboard step, the URL is minted
 * (see planRailwayDeploy). `--run` drives the railway CLI to completion; otherwise print the runbook.
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
import { failStartup } from "../../fail.ts";
import { type HostDeploy, carryCredentials, gateOnModelCredential, registrarsFor, writeArtifacts } from "./shared.ts";

const ISOURS_RAILWAY: HostDeploy["isOurs"] = (path, content) =>
  path.endsWith("railway.json") && isGeneratedRailwayJson(content);

export const railwayHost: HostDeploy = {
  isOurs: ISOURS_RAILWAY,
  async deploy(ctx) {
    const { opts, agentDir, workspace, pre, channels } = ctx;
    const { hasTimeTriggers, modelAuth, modelKeyInDefinition, authPath, container, extraSecrets } = pre;
    // Railway: thin config file, scale-to-zero is a manual dashboard step, the URL is minted (see
    // planRailwayDeploy). --run drives the railway CLI to completion; otherwise print the runbook.
    const serviceName = toRailwayName(basename(workspace));
    const plan = planRailwayDeploy({
      serviceName,
      modelAuth,
      channels,
      extraSecrets,
      hasTimeTriggers,
      ...container,
    });
    await writeArtifacts(workspace, plan.artifacts, { force: !!opts.force, isOurs: ISOURS_RAILWAY });
    if (opts.run) {
      // The BUILD entry is guaranteed by the RAILWAY_DOCKERFILE_PATH service variable the runner sets
      // (Railway's documented non-root-Dockerfile route), and Railway's default restart policy already
      // equals the file's ON_FAILURE — the dashboard-only Config-as-code pointer only adds the /health
      // deploy gate (boot-crash visibility), so it is an OPTIONAL note, not a gate.
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
        modelKeyInDefinition,
        authPath,
        channels,
        extraSecrets,
        intoLinked: !!opts.intoLinked,
        dockerfilePath: dockerfilePathVar(pre.container.agentPrefix),
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  },
};

/**
 * `deploy railway --run`: drive the railway CLI to completion. Mirrors {@link runDeployFly} — same
 * credential carry (env key OR the OAuth auth.json as `FASTAGENT_AUTH_SEED`) via {@link assembleSecrets},
 * same runner seam (spawned `railway`, cwd = the workspace so `railway up`'s upload is the whole workspace). The
 * Railway-specific sequence (linked-check → init/add/volume when fresh → variables → up → domain →
 * webhook) lives in {@link deployRailwayRun}; see there for why Railway differs from Fly.
 */
async function runDeployRailway(
  params: ResolvedPlacement & {
    name: string;
    modelAuth: string | undefined;
    modelKeyInDefinition: boolean;
    authPath: string;
    channels: readonly DeclaredChannel[];
    extraSecrets: string[];
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

  const { secrets, missingSecrets, needsModelCredential } = await carryCredentials(params);
  gateOnModelCredential(needsModelCredential);

  const outcome = await deployRailwayRun(
    { name, mountPath: "/data", secrets, missingSecrets, channels, intoLinked, dockerfilePath },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(agentDir),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → ${outcome.url}`);
}
