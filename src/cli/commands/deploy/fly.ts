/** `deploy fly`: fly.toml + a state volume. */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import {
  isGeneratedFlyToml,
  parseFlyAppName,
  parseFlyMinMachines,
  parseFlyRegion,
  planFlyDeploy,
  toFlyAppName,
} from "../../../deploy/fly/plan.ts";
import { deployFlyRun } from "../../../deploy/fly/run.ts";
import { spawnRunner } from "../../../deploy/runner.ts";
import { type ResolvedPlacement, readTextIfExists } from "../../../paths.ts";
import { failStartup } from "../../fail.ts";
import { type HostDeploy, carryCredentials, gateOnModelCredential, registrarsFor } from "./shared.ts";

export const flyHost: HostDeploy = {
  isOurs: (path, content) => path.endsWith("fly.toml") && isGeneratedFlyToml(content),
  async deploy(ctx) {
    const { opts, agentDir, workspace, channels, longConnectionChannels, pre, write } = ctx;
    const { hasTimeTriggers, modelAuth, modelKeyInDefinition, authPath, container, port, extraSecrets } = pre;
    // The replay floor that makes scale-to-zero safe is Telegram-only (its L1 turn store).
    if (channels.some((channel) => channel.name === "github")) {
      console.error(
        `[fastagent] note: github turns have no replay — the generated fly.toml uses min_machines_running=1 ` +
          `(no scale-to-zero) so autostop can't drop an in-flight review. Set it to 0 to accept that trade.`,
      );
    }
    // Two consistent modes.
    const flyTomlPath = join(agentDir, "fly.toml");
    const flyToml = await readTextIfExists(flyTomlPath).catch(failStartup);
    // Every decision below turns on ONE question — will `writeArtifacts` keep this file?
    const flyTomlKept = flyToml !== undefined && (!opts.force || !isGeneratedFlyToml(flyToml));
    const keptApp = flyTomlKept ? parseFlyAppName(flyToml as string) : undefined;
    const appName = keptApp ?? toFlyAppName(basename(workspace));
    if (keptApp) console.error(`[fastagent] app: ${keptApp} (from fly.toml)`);
    if (flyToml !== undefined && !flyTomlKept) {
      console.error(
        `[fastagent] warn: --force resets fly.toml to defaults (app, region, vm) — re-apply any hand edits`,
      );
    }
    // Autostop flags shape the GENERATED fly.toml only.
    if (flyTomlKept && (opts.stop || opts.scaleToZero === false)) {
      console.error(
        `[fastagent] warn: --stop/--no-scale-to-zero only shape a freshly generated fly.toml — yours exists and ` +
          `was kept. Edit auto_stop_machines/min_machines_running in fly.toml, or pass --force to regenerate.`,
      );
    }
    // KEEP mode + time triggers: the kept fly.toml may still scale to zero — which would sleep through every cron
    // instant / wake-up.
    if (flyTomlKept && (hasTimeTriggers || longConnectionChannels.length > 0)) {
      const min = parseFlyMinMachines(flyToml as string);
      if ((min ?? 0) === 0) {
        // undefined = the line is absent — Fly's platform default for min_machines_running is 0, so a hand-written
        // fly.toml without the line scales to zero exactly like an explicit 0.
        const reason = hasTimeTriggers
          ? `schedules/self-scheduling need a running machine (no external wake-up)`
          : `long-connection channel (${longConnectionChannels.map((c) => c.name).join(", ")}) needs an always-on outbound connection`;
        const msg =
          `your kept fly.toml scales to zero (min_machines_running = ${min ?? "absent → platform default 0"}), but ` +
          `${reason}. Set min_machines_running = 1, or pass --force to regenerate.`;
        if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
        console.error(`[fastagent] warn: ${msg}`);
      }
    }
    const plan = planFlyDeploy({
      appName,
      port,
      modelAuth,
      channels,
      extraSecrets,
      hasTimeTriggers,
      ...container,
      autostop: opts.stop ? "stop" : "suspend",
      scaleToZero: opts.scaleToZero !== false,
    });
    await write(plan.artifacts, { force: !!opts.force });
    if (opts.run) {
      return runDeployFly({
        agentDir,
        workspace,
        agentPrefix: container.agentPrefix,
        appName,
        modelAuth,
        modelKeyInDefinition,
        authPath,
        channels,
        flyTomlPath,
        extraSecrets,
      });
    }
    console.log(plan.runbook.join("\n"));
  },
};

/** `deploy fly --run`: drive flyctl to completion (idempotent, resumable). */
async function runDeployFly(
  params: ResolvedPlacement & {
    /** Where the agent's files sit relative to the build context — `"fastagent/"` or `""` (flat). */
    agentPrefix: string;
    appName: string;
    modelAuth: string | undefined;
    modelKeyInDefinition: boolean;
    authPath: string;
    channels: readonly DeclaredChannel[];
    flyTomlPath: string;
    extraSecrets: string[];
  },
): Promise<void> {
  const { agentDir, workspace, agentPrefix, appName, channels, flyTomlPath } = params;
  const fly = spawnRunner("fly", workspace);
  // Fail fast if flyctl is absent (spawn ENOENT → 127), with the install link — not a confusing auth gate.
  if ((await fly(["version"], { capture: true })).code === 127) {
    failStartup(new Error(`flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run`));
  }

  const region = parseFlyRegion(await readFile(flyTomlPath, "utf8")) ?? "iad";
  const { secrets, missingSecrets, needsModelCredential } = await carryCredentials(params);
  gateOnModelCredential(needsModelCredential);

  const outcome = await deployFlyRun(
    {
      appName,
      region,
      secrets,
      missingSecrets,
      channels,
      flyConfig: `${agentPrefix}fly.toml`,
      dockerfile: `${agentPrefix}Dockerfile`,
    },
    fly,
    (m) => console.error(`[fastagent] ${m}`),
    registrarsFor(agentDir),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → https://${appName}.fly.dev`);
}
