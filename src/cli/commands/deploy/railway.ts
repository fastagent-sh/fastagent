/**
 * `deploy railway`: no config file of its own, scale-to-zero is a manual dashboard step, the URL is minted (see
 * planRailwayDeploy).
 */
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  RAILWAYIGNORE_FILE,
  isGeneratedRailwayignore,
  keptRailwayignoreProblem,
} from "../../../deploy/railway/ignore.ts";
import { planRailwayDeploy, toRailwayName } from "../../../deploy/railway/plan.ts";
import { deployRailwayRun } from "../../../deploy/railway/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { type BoxShell, processShell } from "../../../deploy/box-shell.ts";
import { deliveredConfigArtifact, withPublicUrl } from "../../../deploy/container.ts";
import type { DeploymentApi } from "../../../deploy/api.ts";
import type { ModelKey } from "../../../deploy/secrets.ts";
import { failStartup } from "../../fail.ts";
import { deploySecrets } from "./secrets-step.ts";
import { RAILWAY_LOGIN, hostLogin } from "./host-login.ts";
import { type Answerer, type HostDeploy, boxLoginStep, registrarsFor, urlRecorder } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const railwayHost: HostDeploy = {
  isOurs: (path, content) => path === RAILWAYIGNORE_FILE && isGeneratedRailwayignore(content),
  shell: async (agentDir, name) => railwayShell(toRailwayName(name), agentDir),
  validate({ opts, agentDir }) {
    const problem = keptRailwayignoreProblem(agentDir);
    if (problem === undefined) return;
    if (opts.run) failStartup(new Error(`deploy stopped: ${problem}`));
    console.error(`[fastagent] warn: ${problem}`);
  },
  async deploy(ctx) {
    const { opts, agentDir, name, pre, channels, write } = ctx;
    const { hasCron, modelAuth, boxLogin, container, declaredSecrets, values, valueFile } = pre;
    const serviceName = toRailwayName(name);
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
      return runDeployRailway({
        agentDir,
        // The URL Railway mints is read before the upload, and the image delivers it as `http.publicUrl`.
        deliverPublicUrl: async (url) => {
          const delivered = withPublicUrl(container.config, url);
          await write([deliveredConfigArtifact(delivered.config)], { force: true });
          return delivered.publicUrl;
        },
        name: serviceName,
        modelAuth,
        modelKey: pre.modelKey,
        boxLogin,
        answerer: ctx.answerer,
        api: ctx.api,
        rerun: ctx.rerun,
        channels,
        declaredSecrets,
        values,
        valueFile,
        intoLinked: !!opts.intoLinked,
        config: opts.config,
      });
    }
    console.log(plan.runbook.join("\n"));
    // Railway mints the domain when the runbook's step generates it.
    return undefined;
  },
};

/** `deploy railway --run`: drive the railway CLI to completion. */
async function runDeployRailway(params: {
  agentDir: string;
  name: string;
  modelAuth: string | undefined;
  modelKey: ModelKey;
  /** The provider the box logs in to itself once it is up (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** Who answers the box's login: `--run` continues into it rather than stopping at "not logged in". */
  answerer: Answerer;
  api: DeploymentApi;
  /** The command that runs this deploy again (`DeployContext.rerun`). */
  rerun: string;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  values: ReadonlyMap<string, string>;
  valueFile: string;
  intoLinked: boolean;
  deliverPublicUrl: (url: string) => Promise<string>;
  /** The `--config` file, where a URL a person set is recorded once the box confirms it. */
  config: string | undefined;
}): Promise<string> {
  const { agentDir, name, channels, intoLinked } = params;
  const railway = spawnRunner("railway", agentDir);
  // Fail fast if the railway CLI is absent (spawn ENOENT → 127), with the install link.
  if ((await railway(["--version"], { capture: true })).code === 127) {
    failStartup(new Error(`railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run`));
  }

  const outcome = await deployRailwayRun(
    {
      name,
      mountPath: "/data",
      provideSecrets: deploySecrets({
        host: "railway",
        label: "Railway",
        agentDir,
        opts: { config: params.config },
        answerer: params.answerer,
        api: params.api,
        modelAuth: params.modelAuth,
        modelKey: params.modelKey,
        declaredSecrets: params.declaredSecrets,
        valueFile: params.valueFile,
        values: params.values,
      }),
      channels,
      intoLinked,
      deliverPublicUrl: params.deliverPublicUrl,
      ...urlRecorder(agentDir, params.config, params.values, params.answerer),
      ...boxLoginStep("railway", params, () => railwayShell(name, agentDir)),
      ...hostLogin(RAILWAY_LOGIN, params.answerer, agentDir),
      forAgent: `${params.rerun} --json`,
    },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(params.values, params.answerer),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → ${outcome.url}`);
  return outcome.url;
}

/** `railway ssh` into the service, in the project and environment this directory is linked to. */
function railwayShell(service: string, agentDir: string): BoxShell {
  // One quoted word: the command reaches the box as ONE line its shell parses, the way OpenSSH hands it over.
  return processShell("railway", (command) => ["ssh", "--service", service, "--", `sh -c '${command}'`], agentDir);
}
