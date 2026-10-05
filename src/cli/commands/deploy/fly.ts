/** `deploy fly`: fly.toml + a state volume. */
import { basename, join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
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
import { assembleSecrets } from "../../../deploy/secrets.ts";
import { type BoxShell, processShell } from "../../../deploy/box-shell.ts";
import { failStartup } from "../../fail.ts";
import { isInteractive } from "../../shared.ts";
import { type HostDeploy, boxLoginStep, registrarsFor } from "./shared.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export const flyHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith("fly.toml") && isGeneratedFlyToml(content),
  artifact: "fly.toml",
  async shell(agentDir) {
    const flyToml = await readTextIfExists(join(agentDir, "fly.toml"));
    return flyShell((flyToml && parseFlyAppName(flyToml)) ?? toFlyAppName(basename(agentDir)), agentDir);
  },
  async deploy(ctx) {
    const { opts, agentDir, channels, pre, write } = ctx;
    const { hasCron, modelAuth, boxLogin, container, port, declaredSecrets, values, valueFile } = pre;
    // Two consistent modes.
    const flyTomlPath = join(agentDir, "fly.toml");
    const flyToml = await readTextIfExists(flyTomlPath).catch(failStartup);
    // Every decision below turns on ONE question — will `writeArtifacts` keep this file?
    const flyTomlKept = flyToml !== undefined && (!opts.force || !isGeneratedFlyToml(flyToml));
    const keptApp = flyTomlKept ? parseFlyAppName(flyToml as string) : undefined;
    const appName = keptApp ?? toFlyAppName(basename(agentDir));
    if (keptApp) console.error(`[fastagent] app: ${keptApp} (from fly.toml)`);
    if (flyToml !== undefined && !flyTomlKept) {
      console.error(
        `[fastagent] warn: --force resets fly.toml to defaults (app, region, vm) — re-apply any hand edits`,
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
          `your kept fly.toml scales to zero (min_machines_running = ${min ?? "absent → platform default 0"}), but ` +
          `${residency.why}. Set min_machines_running = 1, or pass --force to regenerate.`;
        if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
        console.error(`[fastagent] warn: ${msg}`);
      }
    }
    const plan = planFlyDeploy({
      appName,
      port,
      boxLogin,
      channels,
      secrets: pre.secrets,
      hasCron,
      ...container,
    });
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      return runDeployFly({
        agentDir,
        appName,
        modelAuth,
        boxLogin,
        input: opts.input !== false && isInteractive(),
        channels,
        declaredSecrets,
        values,
        valueFile,
      });
    }
    console.log(plan.runbook.join("\n"));
  },
};

/** `deploy fly --run`: drive flyctl to completion (idempotent, resumable). */
async function runDeployFly(params: {
  agentDir: string;
  appName: string;
  modelAuth: string | undefined;
  /** The provider the box logs in to itself once it is up (the pre-flight's `boxLogin`). */
  boxLogin: string | undefined;
  /** A person can answer the login: `--run` continues into it rather than stopping at "not logged in". */
  input: boolean;
  channels: readonly DeclaredChannel[];
  declaredSecrets: readonly DeclaredSecret[];
  values: ReadonlyMap<string, string>;
  valueFile: string;
}): Promise<void> {
  const { agentDir, appName, channels } = params;
  const fly = spawnRunner("fly", agentDir);
  // Fail fast if flyctl is absent (spawn ENOENT → 127), with the install link — not a confusing auth gate.
  if ((await fly(["version"], { capture: true })).code === 127) {
    failStartup(new Error(`flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run`));
  }

  const { secrets, missingSecrets } = assembleSecrets({
    modelAuth: params.modelAuth,
    declared: params.declaredSecrets,
    values: params.values,
  });

  const outcome = await deployFlyRun(
    {
      appName,
      secrets,
      missingSecrets,
      valueFile: params.valueFile,
      channels,
      flyConfig: "fly.toml",
      dockerfile: "Dockerfile",
      ...boxLoginStep("fly", params, () => flyShell(appName, agentDir)),
    },
    fly,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(agentDir),
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
