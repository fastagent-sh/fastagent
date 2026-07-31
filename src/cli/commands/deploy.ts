/**
 * `fastagent deploy <host> [dir]`: generate host artifacts from the resolved definition and print an
 * ordered deploy runbook. Host-scoped (`docker` | `fly` | `railway` — the extension seam). It does NOT
 * run the host CLI by default: fastagent owns the definition-aware artifacts and precise runbook;
 * Docker may opt into a generated ephemeral tunnel, while durable ingress stays operator-owned. The pre-flight
 * (config/model/channels/container facts) is host-neutral; the host branch adds its config + run drive.
 * Read-only on the definition; the only writes are generated artifacts (never clobbered without
 * --force). `--run` drives the target CLI instead of printing.
 */
import { MAX_WEBHOOK_BODY_BYTES } from "../../channels/agentcore-limits.ts";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { registerFeishuWebhook } from "../../channels/feishu/register-webhook.ts";
import { readSlackBotAuthEnv } from "../../channels/slack/bot-auth.ts";
import { registerSlackWebhook } from "../../channels/slack/register-webhook.ts";
import { registerTelegramWebhook } from "../../channels/telegram/register-webhook.ts";
import {
  FORWARDER_FILE,
  TEMPLATE_FILE,
  isGeneratedAgentcoreTemplate,
  planAgentcoreDeploy,
} from "../../deploy/agentcore/plan.ts";
import { deployAgentcoreRun } from "../../deploy/agentcore/run.ts";
import { isGeneratedDockerfile, isGeneratedDockerignore } from "../../deploy/container.ts";
import {
  composeHasTunnelService,
  dockerWebhookPaths,
  isGeneratedCompose,
  planDockerDeploy,
  toDockerProjectName,
} from "../../deploy/docker/plan.ts";
import { deployDockerRun } from "../../deploy/docker/run.ts";
import {
  isGeneratedFlyToml,
  parseFlyAppName,
  parseFlyMinMachines,
  parseFlyRegion,
  planFlyDeploy,
  toFlyAppName,
} from "../../deploy/fly/plan.ts";
import { deployFlyRun } from "../../deploy/fly/run.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { dockerfilePathVar, isGeneratedRailwayJson, planRailwayDeploy } from "../../deploy/railway/plan.ts";
import { deployRailwayRun } from "../../deploy/railway/run.ts";
import { spawnRunner } from "../../deploy/runner.ts";
import { assembleSecrets } from "../../deploy/secrets.ts";
import { loadDotEnv } from "../../env.ts";
import { loadConfig, resolveModelSpec } from "../../engines/pi/config.ts";
import { type ResolvedPlacement, resolveStateRoot } from "../../paths.ts";
import { loadSchedules } from "../../schedule/discover.ts";
import { installProxyFetch } from "../../proxy.ts";
import { openExternalUrl } from "../../open-url.ts";
import { exists } from "../../paths.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { announceWebhooks } from "../../tunnel.ts";
import { failStartup, failUsage, placementOrExit } from "../fail.ts";
import { resolveFirstRunModel } from "../shared.ts";

export type DeployHost = "docker" | "fly" | "railway" | "agentcore";

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
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  // ONE deploy semantic: bake the WORKSPACE (WYSIWYG). Artifacts land under the agent dir
  // (`fastagent/`) plus the one workspace-root `.dockerignore` the packers require; host CLIs run
  // from the workspace, which is the build context.
  const placement = placementOrExit(resolve(dirArg));
  const { agentDir, workspace } = placement;
  if (opts.tunnel && host !== "docker") {
    // A flag/host combination the parser cannot see (host is an argument) — usage class, exit 2.
    failUsage(`deploy stopped: --tunnel is supported only by the local Docker target`);
  }
  loadDotEnv(agentDir); // a custom provider/tool may read a key at config load
  installProxyFetch(); // post-deploy channel API calls must honor HTTP(S)_PROXY under Node
  // First-run funnel, FULL picker: the write-back lands the model in fastagent.config.* — exactly what
  // the model-travel gate below requires (--model/env don't reach the deployed box) — and an inline
  // login stores the credential `--run` then carries. Runs BEFORE loadConfig; the read-back sees the
  // rewritten file because loadConfig cache-busts on mtime (a failed write-back still gates, correctly).
  await resolveFirstRunModel(agentDir, { model: opts.model, authPath: opts.authPath, input: opts.input });
  const { config } = await loadConfig(agentDir).catch(failStartup);
  const modelSpec = resolveModelSpec(opts.model, config);
  // The host-neutral pre-flight (model-travel gate, channel discovery, model-auth probe, container facts +
  // their warnings) lives in deploy/preflight.ts — testable in isolation. The CLI prints its messages and
  // stops on its gate; the host branch below adds only the host-specific artifacts + runbook + run drive.
  const pre = await preflightDeploy({
    placement,
    config,
    modelSpec,
    run: !!opts.run,
    force: !!opts.force,
    externalClock: host === "agentcore", // cron rides EventBridge there — the resident-host notes don't apply
    authPathFlag: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by preflight (one owner)
  }).catch(failStartup);
  if (!pre.ok) failStartup(new Error(`deploy stopped: ${pre.gate}`));
  for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
  const {
    channels,
    routeChannels,
    longConnectionChannels,
    hasTimeTriggers,
    modelAuth,
    authPath,
    container,
    port,
    extraSecrets,
  } = pre;
  const hasDeclaredChannels = routeChannels.length + longConnectionChannels.length > 0;

  // Docker: one app service + loopback port + state volume. `--tunnel` shapes the generated topology
  // with an optional Quick Tunnel service; `--run` alone decides whether Docker receives side effects.
  if (host === "docker") {
    if (opts.stop || opts.scaleToZero === false) {
      console.error(`[fastagent] warn: --stop/--no-scale-to-zero are Fly-only — local Compose stays running`);
    }
    if (opts.intoLinked) {
      console.error(`[fastagent] warn: --into-linked is Railway-only — ignored for local Docker`);
    }
    const projectName = toDockerProjectName(basename(workspace));
    const dockerPlan = (tunnel: boolean) =>
      planDockerDeploy({
        projectName,
        port,
        modelAuth,
        channels,
        longConnectionChannels,
        tunnel,
        extraSecrets,
        ...container,
      });
    const requestedTunnel = !!opts.tunnel && (!hasDeclaredChannels || routeChannels.length > 0);
    if (opts.tunnel && hasDeclaredChannels && routeChannels.length === 0) {
      console.error(`[fastagent] note: --tunnel skipped — every channel uses a long connection`);
    }
    let plan = dockerPlan(requestedTunnel);
    // An existing Compose file is authoritative: shape its comparison/runbook from the topology on disk,
    // regardless of the current flag. `--force` is the explicit reset to the requested generated shape.
    const composeFile = join(workspace, plan.composePath);
    let keptWithoutRequestedTunnel = false;
    // Same ownership question as fly.toml: a hand-owned compose file survives --force, so the plan must
    // describe the topology that will actually be there.
    const composeText = await readFile(composeFile, "utf8").catch(() => undefined);
    if (composeText !== undefined && (!opts.force || !isGeneratedCompose(composeText))) {
      const existingHasTunnel = composeHasTunnelService(composeText);
      plan = dockerPlan(existingHasTunnel);
      keptWithoutRequestedTunnel = requestedTunnel && !existingHasTunnel;
    }
    await writeArtifacts(workspace, plan.artifacts, {
      force: !!opts.force,
    });
    if (opts.run) {
      return runDeployDocker({
        agentDir,
        workspace,
        composeFile: plan.composePath,
        port,
        requireTunnel: requestedTunnel,
        modelAuth,
        authPath,
        channels,
        longConnectionChannels,
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
      basename(workspace)
        .replace(/[^a-zA-Z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    const plan = planRailwayDeploy({
      serviceName,
      modelAuth,
      channels,
      longConnectionChannels,
      extraSecrets,
      hasTimeTriggers,
      ...container,
    });
    await writeArtifacts(workspace, plan.artifacts, {
      force: !!opts.force,
    });
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
        authPath,
        channels,
        longConnectionChannels,
        extraSecrets,
        intoLinked: !!opts.intoLinked,
        dockerfilePath: dockerfilePathVar(pre.container.agentPrefix),
      });
    }
    console.log(plan.runbook.join("\n"));
    return;
  }

  // AgentCore: one CloudFormation stack (runtime + forwarder Lambda + EventBridge schedules); no
  // public URL and no resident process — see deploy/agentcore/plan.ts for the topology decisions.
  if (host === "agentcore") {
    if (opts.stop || opts.scaleToZero === false) {
      console.error(
        `[fastagent] warn: --stop/--no-scale-to-zero are Fly-only — AgentCore's idle/lifetime policy lives in ` +
          `the template's LifecycleConfiguration.`,
      );
    }
    if (opts.intoLinked) {
      console.error(`[fastagent] warn: --into-linked is Railway-only — ignored for AgentCore`);
    }
    // Long-connection channels are STRUCTURALLY unsupported: the connection is the ingress, and a
    // reclaimed session has nothing to wake it — events in the gap are silently lost. `--run` gates
    // (deploying a channel that can't connect); generate-only warns and prints the runbook.
    if (longConnectionChannels.length > 0) {
      const msg =
        `long-connection channel (${longConnectionChannels.join(", ")}) cannot run on AgentCore — there is no ` +
        `resident process to hold the connection, and nothing wakes a reclaimed session. Switch the channel ` +
        `to webhook mode (its events then ride the forwarder like every other channel).`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg}`);
    }
    // selfSchedule is fully supported: pending wake-ups are mirrored into one-shot EventBridge
    // schedules via the forwarder (the wake-alarm mechanism — see deploy/agentcore/plan.ts).
    // Schedules feed EventBridge rules — parsed facts (cron/tz), not just file names, so a bad file
    // must surface here (a schedule silently missing its rule would never fire).
    const loaded = await loadSchedules(agentDir).catch(failStartup);
    if (loaded.failures.length > 0) {
      failStartup(
        new Error(
          `deploy stopped: cannot load schedules: ${loaded.failures.map((x) => `${x.label}: ${x.message}`).join("; ")}`,
        ),
      );
    }
    const acName =
      basename(workspace)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    // Every derived AWS name embeds acName; the tightest ceiling is the Lambda function name
    // (`fastagent-<name>-forwarder` ≤ 64 chars). Gate the base instead of silently truncating —
    // truncation would break the redeploy identity (a renamed stack starts blank state).
    if (acName.length > 40) {
      failStartup(
        new Error(
          `deploy stopped: the directory name maps to "${acName}" (${acName.length} chars) — AWS resource ` +
            `names derived from it exceed their limits past 40 chars. Deploy from a shorter directory name.`,
        ),
      );
    }
    const plan = planAgentcoreDeploy({
      name: acName,
      modelAuth,
      channels,
      routeChannels,
      extraSecrets,
      schedules: loaded.schedules.map((s) => ({ name: s.name, cron: s.cron, tz: s.tz })),
      selfSchedule: !!config.selfSchedule,
      ...container,
    });
    for (const u of plan.untranslatableSchedules) {
      // Same discipline as Fly's kept-toml time-trigger gate: a deploy whose schedule silently never
      // fires is worse than a stopped deploy — nothing fails visibly when the instant passes.
      const msg = `schedule "${u.name}" cannot be expressed as an EventBridge rule — ${u.reason}`;
      if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
      console.error(`[fastagent] warn: ${msg} — it will NOT fire on this deployment`);
    }
    // Host capability limit, stated at plan time. GitHub's own webhook contract is 25 MiB, but a
    // Lambda Function URL request caps at 6 MB — so on this host a large payload cannot arrive at
    // all. Better a sentence here than an opaque 502 the first time someone pushes a big diff.
    if (channels.includes("github")) {
      console.error(
        `[fastagent] note: on AgentCore a webhook body is capped at ~${Math.round(MAX_WEBHOOK_BODY_BYTES / (1 << 20))} MiB ` +
          `(the forwarder's Function URL limit); the GitHub channel accepts 25 MiB on a resident host, so the largest ` +
          `payloads are rejected here rather than delivered`,
      );
    }
    // The template IS the topology (EventBridge rules, wake wiring, secrets) — a kept generated
    // template that no longer matches the definition would deploy a stack silently missing the
    // difference (a new schedule with no rule never fires: the exact miss the gate above stops).
    // A hand-written template (marker removed) is the operator's own — kept, never gated.
    const templateArtifact = plan.artifacts.find((a) => a.path.endsWith(TEMPLATE_FILE));
    const templateHome = join(workspace, templateArtifact?.path ?? TEMPLATE_FILE);
    if (!opts.force && templateArtifact && (await exists(templateHome))) {
      const existing = await readFile(templateHome, "utf8");
      if (isGeneratedAgentcoreTemplate(existing) && existing !== templateArtifact.content) {
        const msg =
          `${templateArtifact.path} no longer matches this definition (channels/schedules/selfSchedule changed) — ` +
          `the kept template would silently drop the difference. Pass --force to regenerate (hand edits are lost), ` +
          `or delete the file.`;
        if (opts.run) failStartup(new Error(`deploy stopped: ${msg}`));
        console.error(`[fastagent] warn: ${msg}`);
      }
    }
    await writeArtifacts(workspace, plan.artifacts, {
      force: !!opts.force,
      alwaysWrite: [`${container.agentPrefix}${FORWARDER_FILE}`],
    });
    if (opts.run) {
      return runDeployAgentcore({
        agentDir,
        workspace,
        agentPrefix: container.agentPrefix,
        name: acName,
        modelAuth,
        authPath,
        channels,
        extraSecrets,
        selfSchedule: !!config.selfSchedule,
        // Same predicate the template uses for the forwarder resource — kept in one expression so
        // the run path and the topology cannot disagree about whether a forwarder exists.
        needsForwarder: routeChannels.length > 0 || loaded.schedules.length > 0 || !!config.selfSchedule,
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
  // fly.toml lives in the agent dir (fastagent/fly.toml) — the workspace's own
  // fly.toml (if any) belongs to the host's product deploy and is never read or written here.
  const flyTomlPath = join(agentDir, "fly.toml");
  const flyToml = await readFile(flyTomlPath, "utf8").catch(() => undefined);
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
    console.error(`[fastagent] warn: --force resets fly.toml to defaults (app, region, vm) — re-apply any hand edits`);
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
        : `long-connection channel (${longConnectionChannels.join(", ")}) needs an always-on outbound connection`;
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
    longConnectionChannels,
    extraSecrets,
    hasTimeTriggers,
    ...container,
    autostop: opts.stop ? "stop" : "suspend",
    scaleToZero: opts.scaleToZero !== false,
  });
  await writeArtifacts(workspace, plan.artifacts, {
    force: !!opts.force,
  });
  if (opts.run) {
    return runDeployFly({
      agentDir,
      workspace,
      agentPrefix: container.agentPrefix,
      appName,
      modelAuth,
      authPath,
      channels,
      longConnectionChannels,
      flyTomlPath,
      extraSecrets,
    });
  }
  console.log(plan.runbook.join("\n"));
}

/**
 * Write each generated artifact, under ONE ownership rule: **deploy only ever overwrites its own
 * output.** Each generated file opens with a marker, so a file on disk is either OURS (a previous
 * `deploy` wrote it) or the author's — and `--force` means "my generated artifact is authoritative",
 * which never licenses clobbering a file we did not write. To hand a path back to fastagent, delete it.
 *
 * That single rule replaced a second mechanism (a per-host list of paths exempt from `--force`), which
 * only described one shape: with the agent inside the workspace, the root `.dockerignore` is the
 * WORKSPACE's file and was listed; with the agent flat, the list was empty — so `--force` would have
 * overwritten a hand-written root `Dockerfile` in a repository `init --flat` had explicitly adopted.
 * Ownership is a property of the file, not of where the agent sits.
 *
 * A KEPT file of OURS that no longer matches what deploy would generate now (config/channel/lockfile/
 * version drift — or the author's edits, which we cannot tell apart) is flagged stale; `--force`
 * regenerates that one.
 */
/** Did fastagent generate the file at `path`? ONE table for all five artifact kinds: a kind missing from
 *  it is permanently classified as the author's, which silently turns `--force` into a no-op for that
 *  file (`fly.toml` and `railway.json` were, until the marker predicates below existed). */
function isOurArtifact(path: string, content: string): boolean {
  if (path.endsWith("Dockerfile")) return isGeneratedDockerfile(content);
  if (path.endsWith(".dockerignore")) return isGeneratedDockerignore(content);
  if (path.endsWith("fastagent.compose.yml")) return isGeneratedCompose(content);
  if (path.endsWith("fly.toml")) return isGeneratedFlyToml(content);
  if (path.endsWith("railway.json")) return isGeneratedRailwayJson(content);
  if (path.endsWith(TEMPLATE_FILE)) return isGeneratedAgentcoreTemplate(content);
  return false;
}

/**
 * Write the plan's artifacts under `target`, honouring the ownership rule: a file we did not generate is
 * never touched, ours is kept unless `--force`. Exported for its own test — this is a four-branch state
 * machine over (exists, ours, force) that used to be proven by spawning the CLI eight times, which is
 * command LOGIC re-run through a subprocess (see vitest.config.ts) and the suite's slowest test.
 */
export async function writeArtifacts(
  target: string,
  artifacts: { path: string; content: string }[],
  options: { force: boolean; alwaysWrite?: string[] },
): Promise<void> {
  for (const a of artifacts) {
    const abs = join(target, a.path);
    // Pure build output, not operator-owned configuration. It must track the generated template/runbook.
    if (options.alwaysWrite?.includes(a.path)) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, a.content);
      console.error(`[fastagent] wrote ${a.path}`);
      continue;
    }
    const existing = (await exists(abs)) ? await readFile(abs, "utf8") : undefined;
    const ours = existing !== undefined && isOurArtifact(a.path, existing);
    if (existing !== undefined && !ours) {
      // Only the `.dockerignore` has content checks in preflight — pointing at "the preflight warnings"
      // for the other kinds would send the reader looking for output that is never printed.
      console.error(
        `[fastagent] kept ${a.path} — not generated by fastagent, so --force does not touch it ` +
          `(delete it to let deploy own the path)` +
          (a.path.endsWith(".dockerignore")
            ? `; see the preflight warnings for what it must exclude`
            : a.path.endsWith("Dockerfile")
              ? `; deploy still assumes it listens on $PORT and runs \`fastagent start /app\``
              : ``),
      );
      continue;
    }
    if (existing !== undefined && !options.force) {
      console.error(
        existing !== a.content
          ? `[fastagent] kept ${a.path} — it no longer matches what deploy would generate (config changed, or ` +
              `you edited it); pass --force to regenerate.`
          : `[fastagent] kept ${a.path} (unchanged)`,
      );
      continue;
    }
    await mkdir(dirname(abs), { recursive: true }); // artifacts live under fastagent/
    await writeFile(abs, a.content);
    console.error(`[fastagent] wrote ${a.path}`);
  }
}

function deployEnvironment(agentDir: string, channels: ChannelKind[]): NodeJS.ProcessEnv {
  if (!channels.includes("slack")) return process.env;
  const latest = readSlackBotAuthEnv(join(resolveStateRoot(agentDir), "channels", "slack", "bot-auth.json"));
  return { ...process.env, ...latest };
}

/**
 * `deploy docker --run`: carry local credentials into Compose's child environment, then reconcile the
 * user-owned local topology. Docker owns container/network/volume lifecycle. A Compose tunnel service,
 * when present, yields an ephemeral URL that reuses the same webhook announcer as `dev --tunnel`.
 */
async function runDeployDocker(
  params: ResolvedPlacement & {
    composeFile: string;
    port: number;
    requireTunnel: boolean;
    modelAuth: string | undefined;
    authPath: string;
    channels: ChannelKind[];
    longConnectionChannels: string[];
    extraSecrets: string[];
  },
): Promise<void> {
  const {
    agentDir,
    workspace,
    composeFile,
    port,
    requireTunnel,
    modelAuth,
    authPath,
    channels,
    longConnectionChannels,
    extraSecrets,
  } = params;
  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    longConnectionChannels,
    extraSecrets,
    env: deployEnvironment(agentDir, channels),
  });
  const outcome = await deployDockerRun(
    { composeFile, port, secrets, missingSecrets, needsModelCredential, requireTunnel },
    spawnRunner("docker", workspace),
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
    await announceWebhooks(agentDir, outcome.tunnelUrl, {
      openUrl: openExternalUrl,
      routeChannels: channels.filter((kind) => !longConnectionChannels.includes(kind)),
      stateRoot: resolveStateRoot(agentDir),
    });
    console.error(
      `[fastagent] note: Quick Tunnel URLs are ephemeral — after the tunnel container/Docker daemon ` +
        `restarts, re-run this deploy so webhooks receive the new URL`,
    );
    return;
  }
  const paths = dockerWebhookPaths(channels.filter((kind) => !longConnectionChannels.includes(kind)));
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
 * behind the shared {@link spawnRunner} seam (spawned `fly`, cwd = the workspace so the build context is the whole workspace).
 */
async function runDeployFly(
  params: ResolvedPlacement & {
    /** Where the agent's files sit relative to the build context — `"fastagent/"` or `""` (flat). */
    agentPrefix: string;
    appName: string;
    modelAuth: string | undefined;
    authPath: string;
    channels: ChannelKind[];
    longConnectionChannels: string[];
    flyTomlPath: string;
    extraSecrets: string[];
  },
): Promise<void> {
  const {
    agentDir,
    workspace,
    agentPrefix,
    appName,
    modelAuth,
    authPath,
    channels,
    longConnectionChannels,
    flyTomlPath,
    extraSecrets,
  } = params;
  const fly = spawnRunner("fly", workspace);
  // Fail fast if flyctl is absent (spawn ENOENT → 127), with the install link — not a confusing auth gate.
  if ((await fly(["version"], { capture: true })).code === 127) {
    failStartup(new Error(`flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run`));
  }

  const region = parseFlyRegion(await readFile(flyTomlPath, "utf8")) ?? "iad";
  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    longConnectionChannels,
    extraSecrets,
    env: deployEnvironment(agentDir, channels),
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
    {
      appName,
      region,
      secrets,
      missingSecrets,
      channels,
      longConnectionChannels,
      flyConfig: `${agentPrefix}fly.toml`,
      dockerfile: `${agentPrefix}Dockerfile`,
    },
    fly,
    (m) => console.error(`[fastagent] ${m}`),
    (baseUrl) => registerTelegramWebhook(baseUrl),
    (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
    (baseUrl) => registerSlackWebhook(baseUrl, { stateRoot: resolveStateRoot(agentDir) }),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → https://${appName}.fly.dev`);
}

/**
 * `deploy agentcore --run`: drive aws + docker to completion. Mirrors {@link runDeployFly} — same
 * credential carry via {@link assembleSecrets}, same runner seam (spawned `aws` + `docker`, cwd = the
 * workspace so the build context is the agent). The AgentCore-specific sequence (identity → buildx →
 * ECR → CloudFormation → outputs → webhooks) lives in {@link deployAgentcoreRun}; the params temp
 * file (secret values off argv) is created here — 0600, removed after the run either way.
 */
async function runDeployAgentcore(
  params: ResolvedPlacement & {
    agentPrefix: string;
    name: string;
    modelAuth: string | undefined;
    authPath: string;
    channels: ChannelKind[];
    extraSecrets: string[];
    selfSchedule: boolean;
    needsForwarder: boolean;
  },
): Promise<void> {
  const { agentDir, workspace, agentPrefix, name, modelAuth, authPath, channels, extraSecrets, selfSchedule } = params;
  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
    env: deployEnvironment(agentDir, channels),
  });
  // The wake-alarm shared secret (container ↔ forwarder). Minted fresh each run — both sides receive
  // the SAME parameter, so rotation is atomic; it never needs to be remembered locally.
  if (selfSchedule) secrets.FASTAGENT_WAKE_SECRET = crypto.randomUUID();
  // The forwarder→runtime ingress secret: what makes an envelope the forwarder's rather than any IAM
  // principal's. Minted fresh each run — both sides receive the SAME parameter, so rotation is atomic.
  if (params.needsForwarder) secrets.FASTAGENT_INGRESS_SECRET = crypto.randomUUID();
  if (needsModelCredential) {
    failStartup(
      new Error(
        `deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
      ),
    );
  }
  // The params temp dir holds the ONE file carrying secret values (file:// parameter-overrides —
  // never argv); 0700/0600 and removed after the run, success or gate.
  const paramsDir = await mkdtemp(join(tmpdir(), "fastagent-agentcore-"));
  try {
    const outcome = await deployAgentcoreRun(
      {
        name,
        templatePath: `${agentPrefix}${TEMPLATE_FILE}`,
        dockerfilePath: agentPrefix ? `${agentPrefix}Dockerfile` : undefined,
        tag: new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, "")
          .slice(0, 14),
        region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        secrets,
        missingSecrets,
        channels,
        // Same predicate the template uses: the forwarder exists for route channels, cron schedules
        // or selfSchedule — and it is what mints the state snapshot's presigned URLs.
        needsForwarder: params.needsForwarder,
      },
      spawnRunner("aws", workspace),
      spawnRunner("docker", workspace),
      (m) => console.error(`[fastagent] ${m}`),
      async (content) => {
        const path = join(paramsDir, "params.json");
        await writeFile(path, content, { mode: 0o600 });
        await chmod(path, 0o600);
        return path;
      },
      async (bytes) => {
        const path = join(paramsDir, "forwarder.zip");
        await writeFile(path, bytes);
        return path;
      },
      (baseUrl) => registerTelegramWebhook(baseUrl),
      (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
      (baseUrl) => registerSlackWebhook(baseUrl, { stateRoot: resolveStateRoot(agentDir) }),
    );
    if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
    console.error(`[fastagent] deployed → ${outcome.runtimeArn}`);
    if (outcome.url) console.error(`[fastagent] webhook ingress → ${outcome.url}`);
    console.error(
      `[fastagent] invoke: aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn ${outcome.runtimeArn} \\\n` +
        `  --runtime-session-id "my-conversation-000000000000000000" \\\n` +
        `  --payload '{"kind":"invoke","session":"cli","text":"hello"}' --cli-binary-format raw-in-base64-out /dev/stdout`,
    );
  } finally {
    await rm(paramsDir, { recursive: true, force: true });
  }
}

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
    authPath: string;
    channels: ChannelKind[];
    longConnectionChannels: string[];
    extraSecrets: string[];
    intoLinked: boolean;
    /** RAILWAY_DOCKERFILE_PATH — the scriptable route to the agent's non-root Dockerfile. */
    dockerfilePath: string;
  },
): Promise<void> {
  const {
    agentDir,
    workspace,
    name,
    modelAuth,
    authPath,
    channels,
    longConnectionChannels,
    extraSecrets,
    intoLinked,
    dockerfilePath,
  } = params;
  const railway = spawnRunner("railway", workspace);
  // Fail fast if the railway CLI is absent (spawn ENOENT → 127), with the install link.
  if ((await railway(["--version"], { capture: true })).code === 127) {
    failStartup(new Error(`railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run`));
  }

  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    longConnectionChannels,
    extraSecrets,
    env: deployEnvironment(agentDir, channels),
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
    { name, mountPath: "/data", secrets, missingSecrets, channels, longConnectionChannels, intoLinked, dockerfilePath },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    (baseUrl) => registerTelegramWebhook(baseUrl),
    (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
    (baseUrl) => registerSlackWebhook(baseUrl, { stateRoot: resolveStateRoot(agentDir) }),
  );
  if (!outcome.ok) failStartup(new Error(`deploy stopped: ${outcome.gate}`));
  console.error(`[fastagent] deployed → ${outcome.url}`);
}
