/**
 * `fastagent start [dir]`: run the agent in production posture — the SAME assembly as dev (your
 * directory is the agent), just no file-watching. No build step: start reads the definition directly.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { authSeedBytes } from "../../deploy/fly/run.ts";
import { loadDotEnv } from "../../env.ts";
import { resolveAuthPath, resolveSessionsDirOverride, resolveWorkspace } from "../../engines/pi/config.ts";
import { isUnderDir } from "../../engines/pi/definition.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "../../engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "../../engines/pi/workspace.ts";
import { log, setLogLevel } from "../../log.ts";
import { logAgentLoop } from "../../observe.ts";
import { installProxyFetch } from "../../proxy.ts";
import { exists } from "../../scaffold/init.ts";
import { failStartup, failStartupOn } from "../fail.ts";
import { maybeTunnel, mountSessionControl, routesFor, serve, startSchedules } from "../serve.ts";
import { parsePort, reportAuth, resolveFirstRunModel } from "../shared.ts";

export interface StartOptions {
  port?: string;
  model?: string;
  sessionsDir?: string;
  authPath?: string;
  tunnel?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const dir = resolve(dirArg);
  const ws = failStartupOn(() => resolveWorkspace(dir));
  setLogLevel("info"); // production posture: info+, the debug turn trace (and its end-user content) gated out
  const portFlag = parsePort(opts.port, "--port", "flag");
  loadDotEnv(ws.root);
  installProxyFetch();
  await resolveFirstRunModel(ws.root, opts);

  // A `deploy --run` may carry the operator's local credential as FASTAGENT_AUTH_SEED —
  // materialize it into the writable secrets dir BEFORE the opener resolves auth (once, absent-only).
  // Same resolveAuthPath the opener uses — ONE owner of the flag > env > default chain.
  await maybeSeedAuth(resolveAuthPath(ws.root, opts.authPath));

  // The same opener dev uses (single assembly source), just no watch.
  const sessionsDirOverride = resolveSessionsDirOverride(opts.sessionsDir);
  const {
    agent,
    definition,
    root,
    workbench,
    layout,
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
  } = await createPiAgentFromWorkspace(dir, {
    model: opts.model,
    sessionsDir: sessionsDirOverride,
    authPath: opts.authPath,
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);

  log.info(`[fastagent] start:  ${workbench}`);
  if (layout === "standalone") log.info(`[fastagent] workspace: ${root} (standalone)`);
  log.info(`[fastagent] model:  ${modelSpec}${config.thinkingLevel ? ` (thinking: ${config.thinkingLevel})` : ""}`);
  await reportAuth(modelSpec, authPath);
  log.info(`[fastagent] context: ${definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  if (definition.persona) log.info(`[fastagent] persona: persona.md`);
  log.info(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (toolNames.length > 0) log.info(`[fastagent] tools:  ${toolNames.join(", ")}`);
  if (deferredToolNames.length > 0) {
    log.info(`[fastagent] deferred: ${deferredToolNames.join(", ")} (activated via search_tools)`);
  }
  reportToolCollisions(toolCollisions);
  reportModuleLoadFailures(toolFailures);
  log.info(`[fastagent] state:  ${stateRoot}`);
  log.info(`[fastagent] sessions: ${sessionsDir}`);
  // State defaults under the workspace root, which a redeploy may replace wholesale. Gate on where the
  // root ACTUALLY resolved (in-tree?), not on the raw env var: an empty `FASTAGENT_STATE_DIR=""` reads
  // as unset (resolveStateRoot) and still lands in-tree, so a raw `=== undefined` check would wrongly
  // silence the warning. A sessions override to a volume does not help — channel state (the
  // telegram turn/context files replay depends on) is still in-tree. (auth.json is NOT under the
  // state root — it lives in the secrets dir, resolveSecretsDir.)
  if (isUnderDir(stateRoot, root)) {
    log.info(
      `[fastagent] note: state (sessions, channel state) lives under the definition dir; point ` +
        `FASTAGENT_STATE_DIR at a persistent volume so a redeploy that replaces the dir does not wipe it.`,
    );
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  // Same debug turn trace as dev; gated out here by the info level (see dev.ts serveOnce).
  const traced = logAgentLoop(agent);
  const routed = await routesFor(root, traced, stateRoot, sessionControl).catch(failStartup);
  const withControl = mountSessionControl(routed.routes, sessionControl, stateRoot, {
    tunnel: opts.tunnel ?? false,
    agent: traced,
  });
  await startSchedules(root, traced, stateRoot, config.selfSchedule ?? false);
  serve(
    { ...routed, routes: withControl.routes },
    portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? config.http?.port ?? 8787,
    (p) => {
      withControl.announce(p);
      maybeTunnel(root, routed.routeChannels, p, opts.tunnel ?? false, stateRoot);
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
  const bytes = authSeedBytes(process.env.FASTAGENT_AUTH_SEED, await exists(authPath));
  if (!bytes) return;
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, bytes);
  log.info(`[fastagent] seeded ${authPath} from FASTAGENT_AUTH_SEED (first boot)`);
}
