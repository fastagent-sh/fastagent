/**
 * `deploy fly`: fly.toml + a state volume. KEEP (no --force): an existing fly.toml is authoritative;
 * --force: the template is. `--run` drives flyctl to completion (idempotent, resumable).
 */
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
    // The replay floor that makes scale-to-zero safe is Telegram-only (its L1 turn store). GitHub turns
    // are fire-and-forget (no replay), so the generated fly.toml keeps one machine running for them —
    // a note, not a warn, since the plan already did the safe thing (definition-aware autostop).
    if (channels.some((channel) => channel.name === "github")) {
      console.error(
        `[fastagent] note: github turns have no replay — the generated fly.toml uses min_machines_running=1 ` +
          `(no scale-to-zero) so autostop can't drop an in-flight review. Set it to 0 to accept that trade.`,
      );
    }
    // Two consistent modes. KEEP (no --force): an existing fly.toml is authoritative — not rewritten,
    // and the runbook reads its `app=` (Fly app names are globally unique, so the basename guess may be
    // taken and the user renamed it). --force: the template is authoritative — the WHOLE fly.toml resets
    // (app→basename, region→iad, vm→defaults), so we do NOT round-trip `app` and warn that hand edits go.
    // fly.toml lives in the agent dir (fastagent/fly.toml) — the workspace's own
    // fly.toml (if any) belongs to the host's product deploy and is never read or written here.
    const flyTomlPath = join(agentDir, "fly.toml");
    const flyToml = await readTextIfExists(flyTomlPath).catch(failStartup);
    // Every decision below turns on ONE question — will `writeArtifacts` keep this file? — and the answer is
    // OWNERSHIP, not the flag: `--force` resets a fly.toml we generated and leaves a hand-written one alone.
    // Keying these on `--force` alone meant a forced deploy of a hand-owned fly.toml took the app name from
    // the directory basename (shipping that file at a DIFFERENT app than it declares) and skipped the
    // scale-to-zero gate below (a schedules deploy that silently sleeps). Read once, decide once.
    const flyTomlKept = flyToml !== undefined && (!opts.force || !isGeneratedFlyToml(flyToml));
    const keptApp = flyTomlKept ? parseFlyAppName(flyToml as string) : undefined;
    const appName = keptApp ?? toFlyAppName(basename(workspace));
    if (keptApp) console.error(`[fastagent] app: ${keptApp} (from fly.toml)`);
    if (flyToml !== undefined && !flyTomlKept) {
      console.error(
        `[fastagent] warn: --force resets fly.toml to defaults (app, region, vm) — re-apply any hand edits`,
      );
    }
    // Autostop flags shape the GENERATED fly.toml only. In KEEP mode (fly.toml exists, no --force) it is
    // not rewritten, so the flags would silently do nothing — surface that instead of a confusing no-op.
    if (flyTomlKept && (opts.stop || opts.scaleToZero === false)) {
      console.error(
        `[fastagent] warn: --stop/--no-scale-to-zero only shape a freshly generated fly.toml — yours exists and ` +
          `was kept. Edit auto_stop_machines/min_machines_running in fly.toml, or pass --force to regenerate.`,
      );
    }
    // KEEP mode + time triggers: the kept fly.toml may still scale to zero — which would sleep through every
    // cron instant / wake-up. The generated plan can't fix a kept file, so surface it instead of the preflight
    // note silently not applying (the author who deployed FIRST and added schedules LATER hits exactly this).
    // Under `--run` this is a GATE (same discipline as the model-travel gate): a full deploy whose schedules
    // silently never fire is worse than a crash-loop — nothing fails visibly when a cron instant passes on a
    // sleeping machine, and unlike github's min=0 there is no legitimate trade to accept here.
    if (flyTomlKept && (hasTimeTriggers || longConnectionChannels.length > 0)) {
      const min = parseFlyMinMachines(flyToml as string);
      if ((min ?? 0) === 0) {
        // undefined = the line is absent — Fly's platform default for min_machines_running is 0, so a
        // hand-written fly.toml without the line scales to zero exactly like an explicit 0.
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

/**
 * `deploy fly --run`: drive flyctl to completion (idempotent, resumable). Gathers the secret VALUES
 * from the local env — the model key (env auth) or the whole auth.json as a `FASTAGENT_AUTH_SEED` seed
 * (OAuth/stored auth: the deployed box materializes it onto the /data volume on first boot, so a
 * personal deploy runs on the SAME subscription) plus channel secrets — then runs the flyctl steps
 * behind the shared {@link spawnRunner} seam (spawned `fly`, cwd = the workspace so the build context is the whole workspace).
 */
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
