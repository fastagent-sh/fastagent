/** `deploy fly`: fly.toml + a state volume. */
import { join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  flyTomlFile,
  isFlyTomlPath,
  isGeneratedFlyToml,
  parseFlyAppName,
  parseFlyMinMachines,
  planFlyDeploy,
  toFlyAppName,
} from "../../../deploy/fly/plan.ts";
import { deployFlyRun } from "../../../deploy/fly/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { readTextIfExists } from "../../../paths.ts";
import { residencyFor } from "../../../deploy/residency.ts";
import { type BoxShell, processShell } from "../../../deploy/box-shell.ts";
import { withPublicUrl } from "../../../deploy/container.ts";
import type { DeploymentApi } from "../../../deploy/api.ts";
import type { ModelKey } from "../../../deploy/secrets.ts";
import { failStartup } from "../../fail.ts";
import { deploySecrets } from "./secrets-step.ts";
import { FLY_LOGIN, hostLogin } from "./host-login.ts";
import { type Answerer, type HostDeploy, boxLoginStep, registrarsFor, urlRecorder } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const flyHost: HostDeploy = {
  isOurs: (path, content) => isFlyTomlPath(path) && isGeneratedFlyToml(content),
  async shell(agentDir, name) {
    const flyToml = await readTextIfExists(join(agentDir, flyTomlFile(name)));
    return flyShell((flyToml && parseFlyAppName(flyToml)) ?? toFlyAppName(name), agentDir);
  },
  async deploy(ctx) {
    const { opts, agentDir, name, channels, pre, write } = ctx;
    const { hasCron, modelAuth, boxLogin, container, port, declaredSecrets, values, valueFile } = pre;
    // Two consistent modes.
    const flyTomlFileName = flyTomlFile(name);
    const flyTomlPath = join(agentDir, flyTomlFileName);
    const flyToml = await readTextIfExists(flyTomlPath).catch(failStartup);
    // Every decision below turns on ONE question — will `writeArtifacts` keep this file?
    const flyTomlKept = flyToml !== undefined && (!opts.force || !isGeneratedFlyToml(flyToml));
    const keptApp = flyTomlKept ? parseFlyAppName(flyToml as string) : undefined;
    const appName = keptApp ?? toFlyAppName(name);
    if (keptApp) console.error(`[fastagent] app: ${keptApp} (from ${flyTomlFileName})`);
    if (flyToml !== undefined && !flyTomlKept) {
      console.error(
        `[fastagent] warn: --force resets ${flyTomlFileName} to defaults (app, region, vm) — re-apply any hand edits`,
      );
    }
    // KEEP mode: the kept fly.toml may still scale to zero — which would sleep through the very thing the
    // GENERATED one keeps a machine up for. Same question, same answer: `residencyFor` decides, here too, so the
    // kept-file gate and the generated setting cannot disagree.
    const residency = residencyFor({ channels, hasCron });
    if (flyTomlKept && residency) {
      const min = parseFlyMinMachines(flyToml as string);
      if ((min ?? 0) === 0) {
        // undefined = the line is absent — Fly's platform default for min_machines_running is 0, so a hand-written
        // fly.toml without the line scales to zero exactly like an explicit 0.
        const msg =
          `your kept ${flyTomlFileName} scales to zero (min_machines_running = ${min ?? "absent → platform default 0"}), but ` +
          `${residency.why}. Set min_machines_running = 1, or pass --force to regenerate.`;
        if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
        console.error(`[fastagent] warn: ${msg}`);
      }
    }
    const reachedAt = `https://${appName}.fly.dev`;
    const delivered = withPublicUrl(container.config, reachedAt);
    const plan = planFlyDeploy({
      appName,
      port,
      boxLogin,
      channels,
      secrets: pre.secrets,
      hasCron,
      ...container,
      // The app's URL is known before the build, so the image names it: the box points its own channels there.
      config: delivered.config,
      publicUrl: delivered.publicUrl,
    });
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      await runDeployFly({
        agentDir,
        appName,
        flyConfig: flyTomlFileName,
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
        publicUrl: delivered.publicUrl,
        config: opts.config,
      });
      return reachedAt;
    }
    console.log(plan.runbook.join("\n"));
    return reachedAt;
  },
};

/** `deploy fly --run`: drive flyctl to completion (idempotent, resumable). */
async function runDeployFly(params: {
  agentDir: string;
  appName: string;
  /** The instance's manifest, in the agent directory. */
  flyConfig: string;
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
  /** The `http.publicUrl` the image delivers: the platforms reach the box there. */
  publicUrl: string;
  /** The `--config` file, where a URL a person set is recorded once the box confirms it. */
  config: string | undefined;
}): Promise<void> {
  const { agentDir, appName, channels } = params;
  const fly = spawnRunner("fly", agentDir);
  // Fail fast if flyctl is absent (spawn ENOENT → 127), with the install link — not a confusing auth gate.
  if ((await fly(["version"], { capture: true })).code === 127) {
    failStartup(new Error(`flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run`));
  }

  const outcome = await deployFlyRun(
    {
      appName,
      provideSecrets: deploySecrets({
        host: "fly",
        label: "Fly",
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
      flyConfig: params.flyConfig,
      dockerfile: "Dockerfile",
      ...boxLoginStep("fly", params, () => flyShell(appName, agentDir)),
      ...hostLogin(FLY_LOGIN, params.answerer, agentDir),
      forAgent: `${params.rerun} --json`,
      publicUrl: params.publicUrl,
      ...urlRecorder(agentDir, params.config, params.values, params.answerer),
    },
    fly,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(params.values, params.answerer),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → https://${appName}.fly.dev`);
}

/** `fly ssh console` into the app's machine, woken first: a suspended machine has no shell to open. */
function flyShell(app: string, agentDir: string): BoxShell {
  return {
    ...processShell(
      "fly",
      (command) => ["ssh", "console", "--app", app, "--quiet", "--command", `sh -c '${command}'`],
      agentDir,
    ),
    // `fly ssh` fails with "no started VMs" while the machine is suspended, and a request is what resumes it. The
    // answer is not the point: a machine that stays down makes the shell fail right after, with Fly's own reason.
    wake: async () => {
      await fetch(`https://${app}.fly.dev/health`, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    },
  };
}
