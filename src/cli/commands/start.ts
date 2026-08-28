/**
 * `fastagent start [dir]`: run the agent in production posture — the SAME assembly as dev (your
 * directory is the agent), just no file-watching. No build step: start reads the definition directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { authSeedBytes, collectAuthSeed } from "../../deploy/fly/run.ts";
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath, resolveSessionsDirOverride } from "../../engines/pi/config.ts";
import { resolveSecretsDir, workspaceHint, isUnderDir, exists } from "../../paths.ts";
import { reportFindingsIfChanged, reportToolCollisions } from "../../engines/pi/report.ts";
import { reportModuleLoadFailures, log, setLogLevel } from "../../log.ts";
import { CODING_TOOL_NAMES } from "../../engines/pi/create.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { mountAgentService } from "../../service.ts";
import { logAgentLoop } from "../../observe.ts";
import { installProxyFetch } from "../../proxy.ts";
import { bindAddress } from "../../bind.ts";

import { isAgentcoreRuntime, mountAgentcoreService } from "../../channels/agentcore-service.ts";
import { createWakeAlarmSink, reconcileWakeAlarms } from "../../schedule/wake-alarm.ts";
import { setWakeupsSink } from "../../schedule/wakeups.ts";
import { failStartup, placementOrExit } from "../fail.ts";
import { SHUTDOWN_GRACE_MS, assertTunnelBindable, maybeTunnel, reportServing, serve } from "../serve.ts";
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
  const opened = await openStartDir(dir, opts, sessionsDirOverride);
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
  } = opened;

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

  // Same debug turn trace as dev; gated out here by the info level (see dev.ts serveOnce).
  const traced = logAgentLoop(agent);
  // `http.host` enters here the way the flag enters `parseBind` — through `bindAddress`, so a
  // configured `localhost` is an ADDRESS by the time anything binds, renders or dials it.
  const configured = config.http?.host;
  const host = bindFlag ?? (configured === undefined ? undefined : bindAddress(configured));
  assertTunnelBindable(host, opts.tunnel ?? false, bindFlag ? "flag" : "config");
  const control = { tunnel: opts.tunnel ?? false, ...(host !== undefined ? { host } : {}) };
  // ONE branch for the whole posture. AgentCore assembles differently — lazy channels over a
  // pre-restore state mount, an external clock, no resident connections — but it yields the same
  // AgentService, so everything below this point is common.
  // The wake-alarm sink is a PROCESS-global (schedule/wakeups.ts) — this process IS the AgentCore
  // deployment, so the process entry installs it. A service can be closed; a global cannot be
  // handed to something that can, without inventing an ownership the singleton does not have.
  const onStateReady = isAgentcoreRuntime() && config.selfSchedule ? armWakeAlarms(stateRoot) : undefined;
  const service = await (isAgentcoreRuntime()
    ? mountAgentcoreService(opened, { wrapAgent: () => traced, control, onStateReady })
    : mountAgentService(opened, {
        wrapAgent: () => traced,
        closeTimeoutMs: SHUTDOWN_GRACE_MS,
        control,
        onChannelClosed: (name, error) =>
          failStartup(new Error(`${name} ${error === undefined ? "closed unexpectedly" : `failed: ${String(error)}`}`)),
      })
  ).catch(failStartup);
  serve(
    service.handler,
    { port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? config.http?.port ?? 8787, host },
    {
      ready: service.ready,
      onListening: (p) => {
        reportServing(service, host, p);
        service.announce(p);
        maybeTunnel(agentDir, service.channels.routes, p, opts.tunnel ?? false, stateRoot);
      },
      onShutdown: () => service.close(),
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
/** The opener, kept as its own call so `opened` can also feed the shared assembly below. */
function openStartDir(dir: string, opts: StartOptions, sessionsDir: string | undefined) {
  return createPiAgentFromDir(dir, {
    model: opts.model,
    sessionsDir,
    authPath: opts.authPath,
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);
}

async function maybeSeedAuth(authPath: string): Promise<void> {
  // collectAuthSeed: the seed may arrive CHUNKED (FASTAGENT_AUTH_SEED + _2…) on hosts with a small
  // env-value max length (AgentCore); single-var hosts are unchanged.
  const bytes = authSeedBytes(collectAuthSeed(process.env), await exists(authPath));
  if (!bytes) return;
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, bytes);
  log.info(`[fastagent] seeded ${authPath} from FASTAGENT_AUTH_SEED (first boot)`);
}

/**
 * Install the wake-ALARM sink before the scheduler starts — the boot wake pump may advance a
 * recurring entry, and that save must already re-arm its alarm. Returns the post-restore reconcile:
 * running it at boot would read the pre-restore state mount, see no pending wake-ups, and conclude
 * there is nothing to re-arm.
 */
function armWakeAlarms(stateRoot: string): (() => void) | undefined {
  const secret = process.env.FASTAGENT_WAKE_SECRET;
  if (!secret) {
    log.warn(
      `[fastagent] FASTAGENT_WAKE_SECRET is not set — wake-ups fire only while a session is awake ` +
        `(redeploy with the current template to fix)`,
    );
    return undefined;
  }
  const sink = createWakeAlarmSink({ secret });
  setWakeupsSink(sink);
  log.info(`[fastagent] wake alarms: EventBridge-backed via the forwarder`);
  return () => reconcileWakeAlarms(stateRoot, sink);
}
