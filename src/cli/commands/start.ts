/** Production serving. */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { applyCarriedEnv } from "../../deploy/secrets.ts";
import {
  applyReleaseEnv,
  installAgentDependencies,
  parseDeploymentRelease,
  prepareDeployment,
} from "../../deploy/workspace.ts";
import { resolveSecretsDir, isAgentcoreRuntime, isUnderDir, exists } from "../../paths.ts";
import { log, setLogLevel } from "../../log.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { DEFAULT_HTTP_PORT, mountAgentService, type AgentService } from "../../service.ts";
import { logAgentLoop } from "../../observe.ts";
import { mountAgentcoreService, deferAgentcoreService } from "../../channels/agentcore-service.ts";
import { createWakeAlarmSink } from "../../schedule/wake-alarm.ts";
import { setWakeupsSink } from "../../schedule/wakeups.ts";
import { failStartup } from "../fail.ts";
import {
  announceControl,
  assertTunnelBindable,
  bindLine,
  cliMountOptions,
  serveService,
  serve,
  withRunOverrides,
} from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

export interface StartOptions {
  port?: string;
  bind?: string;
  model?: string;
  tunnel?: boolean;
  /** false ⇔ `--no-invoke`: withhold `POST /invoke` for THIS run (`http.invoke` is the persistent form). */
  invoke?: boolean;
  input?: boolean;
}

type StartedService = AgentService & { stateRoot: string; port: number };

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  // A host that carries the value file as ONE encoded variable (AgentCore): expanded before anything reads the env.
  try {
    applyCarriedEnv();
  } catch (error) {
    failStartup(error);
  }
  setLogLevel("info");
  if (isAgentcoreRuntime()) {
    // The generated Runtime resource sets PORT; 8080 is the platform's contract when nothing does.
    const port = portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? 8080;
    const deferred = deferAgentcoreService({
      prepare: () => prepareStartWorkspace(dirArg),
      assemble: async (prepared) => {
        const service = await openPreparedWorkspace(prepared, opts);
        await service.ready;
        announceControl(service, { host: bindFlag, tunnel: false });
        return service;
      },
    });
    serve(
      deferred.handler,
      { port, host: bindFlag },
      {
        // The assembly report waits for the first envelope, so this line is the only sign of life a booted container
        // gives.
        onListening: (port) => {
          // NOT `readyAddressLines`: this posture serves the Runtime's `/invocations` contract, not our `/invoke`.
          log.info(bindLine(bindFlag, port));
          log.info("[fastagent] agentcore: the definition opens on the first invocation");
        },
        onShutdown: () => deferred.close(),
      },
    );
    return;
  }
  // Deployed storage refusals (no mount, a held lease, a missing `flock`, a failed install) are the operator's only
  // clue in a crash-looping container.
  const service = await openStartService(dirArg, opts).catch(failStartup);
  const tunnel = opts.tunnel ?? false;
  // An unset bind stays the wildcard: this is the container posture, and a published port needs it.
  assertTunnelBindable(bindFlag, tunnel);
  serveService(
    service,
    { port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? service.port, host: bindFlag },
    { tunnel, agentDir: service.agentDir, stateRoot: service.stateRoot },
  );
}

/** What the storage stage hands the opening stage. */
export interface PreparedWorkspace {
  /** The agent directory to open — the storage's deployed definition when a release manifest selected one. */
  dir: string;
  /** The storage root, set when this process took a deployment's storage. */
  deployed?: { root: string };
}

/**
 * Stage one — TAKE the storage: verify it is mounted, apply the release, and point the machinery at the volume.
 */
export async function prepareStartWorkspace(dirArg: string): Promise<PreparedWorkspace> {
  const manifestPath = process.env.FASTAGENT_RELEASE_FILE;
  if (!manifestPath) return { dir: dirArg };
  const storage = process.env.FASTAGENT_STORAGE_DIR;
  if (!storage) throw new Error("FASTAGENT_STORAGE_DIR is required for a deployment");
  const root = resolve(storage);
  const manifest = parseDeploymentRelease(await readFile(manifestPath, "utf8"));
  const dir = await prepareDeployment(resolve(dirArg), root, manifest);
  // Defaults, not overrides: an operator who pointed either dir somewhere else meant it, and silently relocating
  // their state is the one failure they could not diagnose from the logs.
  process.env.FASTAGENT_STATE_DIR ||= join(root, ".state");
  process.env.FASTAGENT_SECRETS_DIR ||= join(root, ".secrets");
  // The release's own declarations, projected into the environment it was resolved FOR. This must stay BEFORE
  // `enterAgentEnv` reads the agent's `.env`, which is what makes either source outrank a value edited on the
  // box (applyReleaseEnv's own tests pin the precedence).
  applyReleaseEnv(manifest);
  process.chdir(dir);
  return { dir, deployed: { root } };
}

/**
 * Stage two — RUN the prepared agent directory: install its dependencies, then open through its own FastAgent install.
 */
async function openPreparedWorkspace(prepared: PreparedWorkspace, opts: StartOptions): Promise<StartedService> {
  let open = openPreparedStartService;
  if (prepared.deployed) {
    const { root } = prepared.deployed;
    const agentDir = prepared.dir;
    if (await exists(join(agentDir, "package.json"))) {
      await installAgentDependencies(root, agentDir);
      // Tools and their session context must share the agent's runtime module instance.
      const entry = createRequire(join(agentDir, "package.json")).resolve("@fastagent-sh/fastagent");
      const local = (await import(
        new URL("./cli/commands/start.js", pathToFileURL(entry)).href
      )) as typeof import("./start.ts");
      // A version-skewed dependency resolves and imports fine, then fails as "open is not a function" with nothing
      // naming the two versions.
      if (typeof local.openPreparedStartService !== "function") {
        throw new Error(
          `${entry} does not export openPreparedStartService — align the agent's @fastagent-sh/fastagent version with the deploy CLI`,
        );
      }
      open = local.openPreparedStartService;
    }
  }
  return open(prepared.dir, opts);
}

export async function openStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  return openPreparedWorkspace(await prepareStartWorkspace(dirArg), opts);
}

/** Internal entry loaded from the agent's installed package after storage initialization. */
export async function openPreparedStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  const agentDir = await enterAgentCommand(dirArg, opts);
  const opened = await createPiAgentFromDir(agentDir, {
    model: opts.model,
    serving: true,
  });
  const { agent, config, stateRoot, sessionsDir } = opened;
  await reportAssembly(opened, {
    afterTools: [
      ["state", stateRoot],
      ["sessions", sessionsDir],
    ],
  });
  if (isUnderDir(stateRoot, agentDir)) {
    log.info(
      "[fastagent] note: state lives under the definition; use FASTAGENT_STATE_DIR on persistent storage for deployment.",
    );
  }
  if (isUnderDir(resolveSecretsDir(agentDir), agentDir)) {
    log.info(
      "[fastagent] note: credentials live under the definition; use FASTAGENT_SECRETS_DIR on persistent storage for deployment.",
    );
  }
  const traced = logAgentLoop(agent);
  const onStateReady = isAgentcoreRuntime() ? armWakeAlarms(stateRoot) : undefined;
  const mountable = withRunOverrides(opened, opts);
  const service = await (isAgentcoreRuntime()
    ? mountAgentcoreService(mountable, { wrapAgent: () => traced, onStateReady })
    : mountAgentService(
        mountable,
        cliMountOptions(() => traced),
      ));
  return { ...service, stateRoot, port: config.http?.port ?? DEFAULT_HTTP_PORT };
}

/**
 * Install the wake-ALARM sink before the scheduler starts: the first wake poll may advance a recurring entry, and that
 * save must already re-arm its alarm.
 */
function armWakeAlarms(stateRoot: string): (() => void) | undefined {
  const secret = process.env.FASTAGENT_WAKE_SECRET;
  if (!secret) {
    log.warn("[fastagent] FASTAGENT_WAKE_SECRET is missing; external wake alarms cannot be registered");
    return undefined;
  }
  const sink = Effect.runSync(createWakeAlarmSink({ secret }));
  setWakeupsSink(sink);
  return () => sink(stateRoot);
}
