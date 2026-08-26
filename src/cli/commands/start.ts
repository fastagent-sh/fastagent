/**
 * `fastagent start [dir]`: run the agent in production posture — the SAME assembly as dev (your
 * directory is the agent), just no file-watching. No build step: start reads the definition directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { authSeedBytes, collectAuthSeed } from "../../deploy/fly/run.ts";
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath, resolveSessionsDirOverride } from "../../engines/pi/config.ts";
import { resolveSecretsDir, workspaceHint } from "../../paths.ts";
import { isUnderDir } from "../../engines/pi/definition.ts";
import { reportFindingsIfChanged, reportModuleLoadFailures, reportToolCollisions } from "../../engines/pi/report.ts";
import { CODING_TOOL_NAMES } from "../../engines/pi/create.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { log, setLogLevel } from "../../log.ts";
import { createWakeAlarmSink, reconcileWakeAlarms } from "../../schedule/wake-alarm.ts";
import { setWakeupsSink } from "../../schedule/wakeups.ts";
import { logAgentLoop } from "../../observe.ts";
import { installProxyFetch } from "../../proxy.ts";
import { exists } from "../../paths.ts";
import { bindAddress } from "../../bind.ts";
import type { RouteSurface } from "../../channels/agentcore.ts";

import { failStartup, placementOrExit } from "../fail.ts";
import {
  assertNoControlPlaneCollision,
  assertTunnelBindable,
  maybeTunnel,
  mountAgentcore,
  mountSessionControl,
  routesFor,
  serve,
  startSchedules,
} from "../serve.ts";
import { parseBind, parsePort, reportAuth, reportLine, resolveFirstRunModel, reportWorkspaceHint } from "../shared.ts";

export interface StartOptions {
  port?: string;
  bind?: string;
  model?: string;
  sessionsDir?: string;
  authPath?: string;
  tunnel?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const dir = resolve(dirArg);
  // Flag validation first: a bad --port is a USAGE error (exit 2), and reporting it must not depend on
  // the directory being an agent (which is a runtime/environment failure, exit 1).
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  const placement = placementOrExit(dir);
  setLogLevel("info"); // production posture: info+, the debug turn trace (and its end-user content) gated out
  loadDotEnv(placement.agentDir);
  installProxyFetch();
  await resolveFirstRunModel(placement.agentDir, opts);

  // A `deploy --run` may carry the operator's local credential as FASTAGENT_AUTH_SEED —
  // materialize it into the writable secrets dir BEFORE the opener resolves auth (once, absent-only).
  // Same resolveAuthPath the opener uses — ONE owner of the flag > env > default chain.
  await maybeSeedAuth(resolveAuthPath(placement.agentDir, opts.authPath));

  // The same opener dev uses (single assembly source), just no watch.
  const sessionsDirOverride = resolveSessionsDirOverride(opts.sessionsDir);
  const {
    agent,
    definition,
    agentDir,
    workspace,
    config,
    modelSpec,
    stateRoot,
    sessionsDir,
    authPath,
    toolNames,
    deferredToolNames,
    toolCollisions,
    toolFailures,
    sessionControl,
  } = await createPiAgentFromDir(dir, {
    model: opts.model,
    sessionsDir: sessionsDirOverride,
    authPath: opts.authPath,
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);

  reportLine("agent", agentDir);
  reportLine("workspace", workspace);
  reportWorkspaceHint(workspaceHint({ agentDir, workspace }));
  reportLine("model", `${modelSpec}${config.thinkingLevel ? ` (thinking: ${config.thinkingLevel})` : ""}`);
  await reportAuth(agentDir, modelSpec, authPath);
  reportLine("context", definition.contextFiles.map((f) => f.path).join(", ") || "(none)");
  if (definition.persona) reportLine("persona", "persona.md");
  reportLine("skills", definition.skills.map((s) => s.name).join(", ") || "(none)");
  reportLine("codingTools", CODING_TOOL_NAMES.join(", "));
  if (toolNames.length > 0) reportLine("tools", toolNames.join(", "));
  if (deferredToolNames.length > 0) {
    reportLine("deferred", `${deferredToolNames.join(", ")} (activated via search_tools)`);
  }
  reportToolCollisions(toolCollisions);
  reportModuleLoadFailures(toolFailures);
  reportLine("state", stateRoot);
  reportLine("sessions", sessionsDir);
  // State defaults under the agent dir, which a redeploy may replace wholesale. Gate on where the
  // state root ACTUALLY resolved (inside the agent dir?), not on the raw env var: an empty
  // `FASTAGENT_STATE_DIR=""` reads as unset (resolveStateRoot) and still lands in-agent, so a raw
  // `=== undefined` check would wrongly silence the warning. A sessions override to a volume does not
  // help — channel state (the telegram turn/context files replay depends on) is still in-agent.
  // (auth.json is NOT under the state root — it lives in the secrets dir, resolveSecretsDir.)
  if (isUnderDir(stateRoot, agentDir)) {
    log.info(
      `[fastagent] note: state (sessions, channel state) lives under the definition dir; point ` +
        `FASTAGENT_STATE_DIR at a persistent volume so a redeploy that replaces the dir does not wipe it.`,
    );
  }
  // The secrets dir is the SAME trap on a different lifecycle: auth.json is MACHINE-WRITTEN (OAuth
  // rotation), so the copy under the definition dir is the only valid one — a redeploy that replaces
  // the dir loses a credential no re-seed can restore. An independent check on purpose: moving ONE
  // of the two to a volume must not silence the note about the other.
  if (isUnderDir(resolveSecretsDir(agentDir), agentDir)) {
    log.info(
      `[fastagent] note: secrets (.env, rotated auth.json) live under the definition dir; point ` +
        `FASTAGENT_SECRETS_DIR at a persistent volume so a redeploy that replaces the dir does not wipe them.`,
    );
  }
  reportFindingsIfChanged(definition.dir, definition);

  // AgentCore Runtime posture (FASTAGENT_AGENTCORE=1, set by the generated deploy artifacts): the
  // adapter (POST /invocations + GET /ping) is the container's only reachable surface, and cron
  // slots arrive from the external clock through it — so no resident cron timers. In particular,
  // do NOT mount the ordinary unauthenticated POST /invoke fallback: a selfSchedule-only topology
  // needs a public Function URL for wake callbacks, and its forwarder can relay arbitrary paths.
  const agentcore = process.env.FASTAGENT_AGENTCORE === "1";
  // Same debug turn trace as dev; gated out here by the info level (see dev.ts serveOnce).
  const traced = logAgentLoop(agent);
  // On AgentCore the channels are constructed LAZILY (mountAgentcore's lazyChannels, resolved on the
  // first envelope after the state-snapshot restore): construction loads channel state and replays
  // turn intent, and at boot the state mount is PRE-RESTORE — empty after every version update — so
  // an eager build would cache that emptiness (thread participation, delivery dedup, pending turns)
  // and then clobber the restored files with it. Everywhere else the state root is durable at boot,
  // so channels mount eagerly and a broken channel fails startup.
  const routed = agentcore
    ? undefined
    : await routesFor(agentDir, traced, stateRoot, sessionControl, { builtinInvoke: true }).catch(failStartup);
  // `http.host` enters here the way the flag enters `parseBind` — through `bindAddress`, so a
  // configured `localhost` is an ADDRESS by the time anything binds, renders or dials it.
  const configured = config.http?.host;
  const host = bindFlag ?? (configured === undefined ? undefined : bindAddress(configured));
  assertTunnelBindable(host, opts.tunnel ?? false, bindFlag ? "flag" : "config");
  const withControl = mountSessionControl(routed?.routes ?? {}, sessionControl, stateRoot, {
    tunnel: opts.tunnel ?? false,
    agent: traced,
    host,
  });
  // AgentCore + selfSchedule: register the wake-ALARM sink BEFORE the scheduler starts — the boot
  // wake pump may advance a recurring entry (a store save) and that save must already re-arm its
  // alarm. The secret arrives via the stack (FASTAGENT_WAKE_SECRET); without it the deployment
  // degrades to awake-only wakes — warned, never silent.
  let onStateReady: (() => void) | undefined;
  if (agentcore && config.selfSchedule) {
    const wakeSecret = process.env.FASTAGENT_WAKE_SECRET;
    if (wakeSecret) {
      const sink = createWakeAlarmSink({ secret: wakeSecret });
      setWakeupsSink(sink);
      // NOT here: at boot the state mount is whatever the platform just provisioned — after a runtime
      // version update that is EMPTY, so a reconcile now would see no pending wake-ups and conclude
      // there is nothing to re-arm. It runs once the snapshot has been restored (mountAgentcore).
      onStateReady = () => reconcileWakeAlarms(stateRoot, sink);
      log.info(`[fastagent] wake alarms: EventBridge-backed via the forwarder`);
    } else {
      log.warn(
        `[fastagent] FASTAGENT_WAKE_SECRET is not set — wake-ups fire only while a session is awake ` +
          `(redeploy with the current template to fix)`,
      );
    }
  }
  const scheduled = await startSchedules(agentDir, traced, stateRoot, config.selfSchedule ?? false, {
    externalClock: agentcore,
  });
  process.once("SIGINT", scheduled.stop);
  process.once("SIGTERM", scheduled.stop);
  const schedules = scheduled.schedules;
  let routes = withControl.routes;
  if (agentcore) {
    // The lazy channel surface the adapter resolves post-restore. Control routes ride along so a
    // forwarder-relayed /control/* request dispatches the same as on a direct host. Long-connection
    // channels cannot serve here — scale-to-zero severs a resident connection and nothing
    // re-establishes it — so their presence is a configuration error, surfaced per envelope and by
    // the deploy driver's health probe (there is no boot to fail on this host).
    const lazyChannels = async (): Promise<RouteSurface> => {
      const surface = await routesFor(agentDir, traced, stateRoot, sessionControl, { builtinInvoke: false });
      if (surface.longConnections.length > 0) {
        throw new Error(
          `long-connection channel(s) ${surface.longConnections.map((c) => c.name).join(", ")} cannot serve on ` +
            `AgentCore (scale-to-zero severs resident connections) — use the channel's webhook form`,
        );
      }
      // The SAME rule mountSessionControl applies, through the same function: with no channels at
      // boot its check ran against an empty base, and a spread merge would silently let control win.
      for (const plane of withControl.mounts) assertNoControlPlaneCollision(surface.routes, plane);
      return { routes: { ...surface.routes, ...withControl.routes }, mounts: withControl.mounts };
    };
    try {
      routes = mountAgentcore(routes, { agent: traced, stateRoot, schedules, onStateReady, lazyChannels });
    } catch (e) {
      failStartup(e);
    }
    log.info(`[fastagent] agentcore: serving POST /invocations + GET /ping (FASTAGENT_AGENTCORE=1)`);
  }
  serve(
    {
      ...(routed ?? { longConnections: [], routeChannels: [], builtinInvoke: false, markReady() {} }),
      // Spread WHOLE (see dev.ts): `routes` is re-bound below because agentcore rewraps it, but
      // `mounts` must ride along or the control plane 404s while control.json advertises it.
      ...withControl,
      routes,
    },
    { port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? config.http?.port ?? 8787, host },
    (p) => {
      withControl.announce(p);
      maybeTunnel(agentDir, routed?.routeChannels ?? [], p, opts.tunnel ?? false, stateRoot);
    },
  );
  // No graceful drain: webhook turns run fire-and-forget; SIGTERM just exits mid-turn. Whether an
  // in-flight turn is LOST depends on the channel: the Telegram channel persists turn intent pre-ACK
  // and replays it next start (turn-store.ts, L1 durable execution, at-least-once); HTTP and other
  // channels have no such layer, so their in-flight turns are still lost (the asker re-invokes).
}

/**
 * Materialize `FASTAGENT_AUTH_SEED` (base64 of an auth.json, set by `deploy --run`) into the
 * writable secrets dir ONCE — only when the seed is set AND the auth file is absent, so a refreshed
 * volume copy is never clobbered by the stale seed. Lets a deploy carry the operator's local
 * OAuth/API credential so the box runs on the SAME subscription. No-op locally (the seed is unset).
 */
async function maybeSeedAuth(authPath: string): Promise<void> {
  // collectAuthSeed: the seed may arrive CHUNKED (FASTAGENT_AUTH_SEED + _2…) on hosts with a small
  // env-value max length (AgentCore); single-var hosts are unchanged.
  const bytes = authSeedBytes(collectAuthSeed(process.env), await exists(authPath));
  if (!bytes) return;
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, bytes);
  log.info(`[fastagent] seeded ${authPath} from FASTAGENT_AUTH_SEED (first boot)`);
}
