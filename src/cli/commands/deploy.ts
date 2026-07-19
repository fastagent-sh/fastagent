/**
 * `fastagent deploy <host> [dir]`: generate host artifacts from the resolved definition and print an
 * ordered deploy runbook. Host-scoped (`docker` | `fly` | `railway` — the extension seam). It does NOT
 * run the host CLI by default: fastagent owns the definition-aware artifacts and precise runbook;
 * Docker may opt into a generated ephemeral tunnel, while durable ingress stays operator-owned. The pre-flight
 * (config/model/channels/container facts) is host-neutral; the host branch adds its config + run drive.
 * Read-only on the definition; the only writes are generated artifacts (never clobbered without
 * --force). `--run` drives the target CLI instead of printing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { registerFeishuWebhook } from "../../channels/feishu/register-webhook.ts";
import { registerTelegramWebhook } from "../../channels/telegram/register-webhook.ts";
import { isGeneratedDockerfile } from "../../deploy/container.ts";
import {
  composeHasTunnelService,
  dockerWebhookPaths,
  isGeneratedCompose,
  planDockerDeploy,
  toDockerProjectName,
} from "../../deploy/docker/plan.ts";
import { deployDockerRun } from "../../deploy/docker/run.ts";
import {
  parseFlyAppName,
  parseFlyMinMachines,
  parseFlyRegion,
  planFlyDeploy,
  toFlyAppName,
} from "../../deploy/fly/plan.ts";
import { deployFlyRun } from "../../deploy/fly/run.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { planRailwayDeploy } from "../../deploy/railway/plan.ts";
import { deployRailwayRun } from "../../deploy/railway/run.ts";
import { spawnRunner } from "../../deploy/runner.ts";
import { assembleSecrets } from "../../deploy/secrets.ts";
import { loadDotEnv } from "../../env.ts";
import { loadConfig, resolveAgentDir, resolveModelSpec } from "../../engines/pi/config.ts";
import { installProxyFetch } from "../../proxy.ts";
import { openExternalUrl } from "../../open-url.ts";
import { exists } from "../../scaffold/init.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { announceWebhooks } from "../../tunnel.ts";
import { failStartup, failUsage } from "../fail.ts";

export type DeployHost = "docker" | "fly" | "railway";

export interface DeployOptions {
  run?: boolean;
  tunnel?: boolean;
  force?: boolean;
  stop?: boolean;
  /** false ⇔ `--no-scale-to-zero`. */
  scaleToZero?: boolean;
  intoLinked?: boolean;
  model?: string;
  authPath?: string;
}

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  const target = resolve(dirArg);
  if (opts.tunnel && host !== "docker") {
    // A flag/host combination the parser cannot see (host is an argument) — usage class, exit 2.
    failUsage(`deploy stopped: --tunnel is supported only by the local Docker target`);
  }
  loadDotEnv(target); // a custom provider/tool may read a key at config load
  installProxyFetch(); // post-deploy channel API calls must honor HTTP(S)_PROXY under Node
  const { config } = await loadConfig(target).catch(failStartup);
  const agentDir = resolveAgentDir(target, config);
  const modelSpec = resolveModelSpec(opts.model, config);
  // The host-neutral pre-flight (model-travel gate, channel discovery, model-auth probe, container facts +
  // their warnings) lives in deploy/preflight.ts — testable in isolation. The CLI prints its messages and
  // stops on its gate; the host branch below adds only the host-specific artifacts + runbook + run drive.
  const pre = await preflightDeploy({
    target,
    agentDir,
    config,
    modelSpec,
    run: !!opts.run,
    force: !!opts.force,
    authPathFlag: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by preflight (one owner)
  }).catch(failStartup);
  if (!pre.ok) failStartup(new Error(`deploy stopped: ${pre.gate}`));
  for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
  const { channels, hasTimeTriggers, modelAuth, authPath, container, port, extraSecrets } = pre;

  // Docker: one app service + loopback port + state volume. `--tunnel` shapes the generated topology
  // with an optional Quick Tunnel service; `--run` alone decides whether Docker receives side effects.
  if (host === "docker") {
    if (opts.stop || opts.scaleToZero === false) {
      console.error(`[fastagent] warn: --stop/--no-scale-to-zero are Fly-only — local Compose stays running`);
    }
    if (opts.intoLinked) {
      console.error(`[fastagent] warn: --into-linked is Railway-only — ignored for local Docker`);
    }
    const projectName = toDockerProjectName(basename(target));
    const dockerPlan = (tunnel: boolean) =>
      planDockerDeploy({ projectName, port, modelAuth, channels, tunnel, extraSecrets, ...container });
    const requestedTunnel = !!opts.tunnel;
    let plan = dockerPlan(requestedTunnel);
    // An existing Compose file is authoritative: shape its comparison/runbook from the topology on disk,
    // regardless of the current flag. `--force` is the explicit reset to the requested generated shape.
    const composeFile = join(target, plan.composePath);
    let keptWithoutRequestedTunnel = false;
    if (!opts.force && (await exists(composeFile))) {
      const existingHasTunnel = composeHasTunnelService(await readFile(composeFile, "utf8"));
      plan = dockerPlan(existingHasTunnel);
      keptWithoutRequestedTunnel = requestedTunnel && !existingHasTunnel;
    }
    await writeArtifacts(target, plan.artifacts, {
      force: !!opts.force,
      neverForce: container.kitDir ? [".dockerignore"] : [],
    });
    if (opts.run) {
      return runDeployDocker({
        target,
        agentDir,
        composeFile: plan.composePath,
        port,
        requireTunnel: requestedTunnel,
        modelAuth,
        authPath,
        channels,
        extraSecrets,
      });
    }
    if (keptWithoutRequestedTunnel) {
      console.error(
        `[fastagent] warn: --tunnel was requested but kept ${plan.composePath} has no "tunnel" service — ` +
          `edit it, delete it and regenerate, or pass --force`,
      );
    }
    console.log(plan.runbook.join("\n"));
    return;
  }

  // Railway: thin config file, scale-to-zero is a manual dashboard step, the URL is minted (see
  // planRailwayDeploy). --run drives the railway CLI to completion; otherwise print the runbook.
  if (host === "railway") {
    if (opts.stop || opts.scaleToZero === false) {
      console.error(
        `[fastagent] warn: --stop/--no-scale-to-zero are Fly-only — Railway's App Sleeping is a dashboard toggle ` +
          `(the runbook states the manual step).`,
      );
    }
    // Railway service names are project-scoped (not globally unique like a Fly app); slug the dir
    // basename so a name with spaces/odd chars can't break the `railway add --service <name>` command.
    const serviceName =
      basename(target)
        .replace(/[^a-zA-Z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    const plan = planRailwayDeploy({ serviceName, modelAuth, channels, extraSecrets, hasTimeTriggers, ...container });
    await writeArtifacts(target, plan.artifacts, {
      force: !!opts.force,
      neverForce: container.kitDir ? [".dockerignore"] : [],
    });
    if (opts.run) {
      return runDeployRailway({
        target,
        name: serviceName,
        modelAuth,
        authPath,
        channels,
        extraSecrets,
        intoLinked: !!opts.intoLinked,
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  }

  // host === "fly".
  if (opts.intoLinked) {
    console.error(
      `[fastagent] warn: --into-linked is railway-only (fly --run is idempotent — it reuses an existing app/volume)`,
    );
  }
  // The replay floor that makes scale-to-zero safe is Telegram-only (its L1 turn store). GitHub turns
  // are fire-and-forget (no replay), so the generated fly.toml keeps one machine running for them —
  // a note, not a warn, since the plan already did the safe thing (definition-aware autostop).
  if (channels.includes("github")) {
    console.error(
      `[fastagent] note: github turns have no replay — the generated fly.toml uses min_machines_running=1 ` +
        `(no scale-to-zero) so autostop can't drop an in-flight review. Set it to 0 to accept that trade.`,
    );
  }
  // Two consistent modes. KEEP (no --force): an existing fly.toml is authoritative — not rewritten,
  // and the runbook reads its `app=` (Fly app names are globally unique, so the basename guess may be
  // taken and the user renamed it). --force: the template is authoritative — the WHOLE fly.toml resets
  // (app→basename, region→iad, vm→defaults), so we do NOT round-trip `app` and warn that hand edits go.
  // Kit layout: fly.toml lives under the kit (agent/fly.toml) — the host repo's own fly.toml (if any)
  // belongs to the host's product deploy and is never read or written here.
  const flyTomlPath = container.kitDir ? join(target, container.kitDir, "fly.toml") : join(target, "fly.toml");
  const flyTomlExists = await exists(flyTomlPath);
  const keptApp = flyTomlExists && !opts.force ? parseFlyAppName(await readFile(flyTomlPath, "utf8")) : undefined;
  const appName = keptApp ?? toFlyAppName(basename(target));
  if (keptApp) console.error(`[fastagent] app: ${keptApp} (from fly.toml)`);
  if (flyTomlExists && opts.force) {
    console.error(`[fastagent] warn: --force resets fly.toml to defaults (app, region, vm) — re-apply any hand edits`);
  }
  // Autostop flags shape the GENERATED fly.toml only. In KEEP mode (fly.toml exists, no --force) it is
  // not rewritten, so the flags would silently do nothing — surface that instead of a confusing no-op.
  if (flyTomlExists && !opts.force && (opts.stop || opts.scaleToZero === false)) {
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
  if (flyTomlExists && !opts.force && hasTimeTriggers) {
    const min = parseFlyMinMachines(await readFile(flyTomlPath, "utf8"));
    if ((min ?? 0) === 0) {
      // undefined = the line is absent — Fly's platform default for min_machines_running is 0, so a
      // hand-written fly.toml without the line scales to zero exactly like an explicit 0.
      const msg =
        `your kept fly.toml scales to zero (min_machines_running = ${min ?? "absent → platform default 0"}), but ` +
        `schedules/self-scheduling need a running machine (no external wake-up). Set min_machines_running = 1, ` +
        `or pass --force to regenerate.`;
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
  await writeArtifacts(target, plan.artifacts, {
    force: !!opts.force,
    neverForce: container.kitDir ? [".dockerignore"] : [],
  });
  if (opts.run) return runDeployFly({ target, appName, modelAuth, authPath, channels, flyTomlPath, extraSecrets });
  console.log(plan.runbook.join("\n"));
}

/**
 * Write each generated artifact. An existing file is KEPT unless --force — deploy NEVER clobbers a file
 * without it (no silent data loss). A Dockerfile/Compose file WE generated is definition-derived, so a
 * KEPT one that no longer matches what deploy would generate now (config/channel/lockfile/version drift —
 * OR the user's own edits, which we can't distinguish) is flagged stale; --force regenerates it. A
 * hand-written Dockerfile/Compose/ignore or fly.toml's app+region state is simply kept.
 */
async function writeArtifacts(
  target: string,
  artifacts: { path: string; content: string }[],
  options: { force: boolean; neverForce?: string[] },
): Promise<void> {
  for (const a of artifacts) {
    const abs = join(target, a.path);
    // Host-owned paths (the root .dockerignore in the agentDir layout): --force means "MY generated
    // artifact is authoritative", which never licenses clobbering the HOST's file — keep it always.
    if (options.neverForce?.includes(a.path) && (await exists(abs))) {
      console.error(
        `[fastagent] kept ${a.path} — the host repo's own file (never overwritten, even with --force); ` +
          `see the preflight warnings for what it must contain`,
      );
      continue;
    }
    if (!options.force && (await exists(abs))) {
      const existing = await readFile(abs, "utf8");
      const generatedDrift =
        (a.path.endsWith("Dockerfile") && isGeneratedDockerfile(existing)) ||
        (a.path.endsWith("fastagent.compose.yml") && isGeneratedCompose(existing));
      if (generatedDrift && existing !== a.content) {
        console.error(
          `[fastagent] kept ${a.path} — it no longer matches what deploy would generate (config changed, or ` +
            `you edited it); pass --force to regenerate.`,
        );
      } else {
        console.error(`[fastagent] kept ${a.path} (exists — pass --force to overwrite)`);
      }
      continue;
    }
    await mkdir(dirname(abs), { recursive: true }); // kit-layout artifacts live under agent/
    await writeFile(abs, a.content);
    console.error(`[fastagent] wrote ${a.path}`);
  }
}

/**
 * `deploy docker --run`: carry local credentials into Compose's child environment, then reconcile the
 * user-owned local topology. Docker owns container/network/volume lifecycle. A Compose tunnel service,
 * when present, yields an ephemeral URL that reuses the same webhook announcer as `dev --tunnel`.
 */
async function runDeployDocker(params: {
  target: string;
  agentDir: string;
  composeFile: string;
  port: number;
  requireTunnel: boolean;
  modelAuth: string | undefined;
  authPath: string;
  channels: ChannelKind[];
  extraSecrets: string[];
}): Promise<void> {
  const { target, agentDir, composeFile, port, requireTunnel, modelAuth, authPath, channels, extraSecrets } = params;
  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
    env: process.env,
  });
  const outcome = await deployDockerRun(
    { composeFile, port, secrets, missingSecrets, needsModelCredential, requireTunnel },
    spawnRunner("docker", target),
    (message) => console.error(`[fastagent] ${message}`),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));

  const compose = `docker compose -f ${composeFile}`;
  console.error(`[fastagent] running${outcome.url ? ` → ${outcome.url}` : ""}`);
  console.error(`[fastagent] logs: ${compose} logs -f agent`);
  console.error(`[fastagent] stop: ${compose} down (state volume is kept)`);
  if (outcome.tunnelUrl) {
    // Docker Desktop commonly injects a host proxy. The Quick Tunnel hostname may be resolvable only
    // through it, exactly like provider/channel APIs; use the same Node dispatcher as dev/start/login.
    installProxyFetch();
    await announceWebhooks(agentDir, outcome.tunnelUrl, { openUrl: openExternalUrl });
    console.error(
      `[fastagent] note: Quick Tunnel URLs are ephemeral — after the tunnel container/Docker daemon ` +
        `restarts, re-run this deploy so webhooks receive the new URL`,
    );
    return;
  }
  const paths = dockerWebhookPaths(channels);
  if (paths.length > 0) {
    console.error(
      `[fastagent] note: public ingress is operator-owned — configure your tunnel/proxy, then wire the ` +
        `default webhook path(s): ${paths.join(", ")} (or your remapped channel routes)`,
    );
  }
}

/**
 * `deploy fly --run`: drive flyctl to completion (idempotent, resumable). Gathers the secret VALUES
 * from the local env — the model key (env auth) or the whole auth.json as a `FASTAGENT_AUTH_SEED` seed
 * (OAuth/stored auth: the deployed box materializes it onto the /data volume on first boot, so a
 * personal deploy runs on the SAME subscription) plus channel secrets — then runs the flyctl steps
 * behind the shared {@link spawnRunner} seam (spawned `fly`, cwd = the workspace so the build context is the agent).
 */
async function runDeployFly(params: {
  target: string;
  appName: string;
  modelAuth: string | undefined;
  authPath: string;
  channels: ChannelKind[];
  flyTomlPath: string;
  extraSecrets: string[];
}): Promise<void> {
  const { target, appName, modelAuth, authPath, channels, flyTomlPath, extraSecrets } = params;
  const fly = spawnRunner("fly", target);
  // Fail fast if flyctl is absent (spawn ENOENT → 127), with the install link — not a confusing auth gate.
  if ((await fly(["version"], { capture: true })).code === 127) {
    failStartup(new Error(`flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run`));
  }

  const region = parseFlyRegion(await readFile(flyTomlPath, "utf8")) ?? "iad";
  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
    env: process.env,
  });
  // Model credential has its OWN remediation (login), distinct from a missing secret's (.env) — gate it
  // here, not through missingSecrets, so the message isn't a contradictory mash of both.
  if (needsModelCredential) {
    failStartup(
      new Error(
        `deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
      ),
    );
  }

  const outcome = await deployFlyRun(
    { appName, region, secrets, missingSecrets, channels, flyConfig: "fly.toml" },
    fly,
    (m) => console.error(`[fastagent] ${m}`),
    (baseUrl) => registerTelegramWebhook(baseUrl),
    (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → https://${appName}.fly.dev`);
}

/**
 * `deploy railway --run`: drive the railway CLI to completion. Mirrors {@link runDeployFly} — same
 * credential carry (env key OR the OAuth auth.json as `FASTAGENT_AUTH_SEED`) via {@link assembleSecrets},
 * same runner seam (spawned `railway`, cwd = the workspace so `railway up`'s upload is the agent). The
 * Railway-specific sequence (linked-check → init/add/volume when fresh → variables → up → domain →
 * webhook) lives in {@link deployRailwayRun}; see there for why Railway differs from Fly.
 */
async function runDeployRailway(params: {
  target: string;
  name: string;
  modelAuth: string | undefined;
  authPath: string;
  channels: ChannelKind[];
  extraSecrets: string[];
  intoLinked: boolean;
}): Promise<void> {
  const { target, name, modelAuth, authPath, channels, extraSecrets, intoLinked } = params;
  const railway = spawnRunner("railway", target);
  // Fail fast if the railway CLI is absent (spawn ENOENT → 127), with the install link.
  if ((await railway(["--version"], { capture: true })).code === 127) {
    failStartup(new Error(`railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run`));
  }

  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
    env: process.env,
  });
  // Model credential has its OWN remediation (login), distinct from a missing secret's (.env).
  if (needsModelCredential) {
    failStartup(
      new Error(
        `deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
      ),
    );
  }

  const outcome = await deployRailwayRun(
    { name, mountPath: "/data", secrets, missingSecrets, channels, intoLinked },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    (baseUrl) => registerTelegramWebhook(baseUrl),
    (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → ${outcome.url}`);
}
