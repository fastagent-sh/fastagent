/** Production serving. Deployed storage is prepared before the active definition is opened. */
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileAtomic } from "../../atomic-write.ts";
import { authSeedBytes, collectAuthSeed } from "../../deploy/secrets.ts";
import { parseDeploymentRelease, prepareDeployment } from "../../deploy/workspace.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import { resolveAuthPath, resolveSessionsDirOverride } from "../../engines/pi/config.ts";
import {
  SECRET_FILE_MODE,
  ensureSecretsDir,
  resolveSecretsDir,
  isAgentcoreRuntime,
  isUnderDir,
  exists,
} from "../../paths.ts";
import { log, setLogLevel } from "../../log.ts";
import { createPiAgentFromDir } from "../../engines/pi/open.ts";
import { mountAgentService, type AgentService } from "../../service.ts";
import { logAgentLoop } from "../../observe.ts";
import { mountAgentcoreService, deferAgentcoreService } from "../../channels/agentcore-service.ts";
import { createWakeAlarmSink } from "../../schedule/wake-alarm.ts";
import { setWakeupsSink } from "../../schedule/wakeups.ts";
import { failStartup } from "../fail.ts";
import { announceControl, cliMountOptions, readyAddressLines, resolveBindHost, serveService, serve } from "../serve.ts";
import { enterAgentCommand, parseBind, parsePort, reportAssembly } from "../shared.ts";

export interface StartOptions {
  port?: string;
  bind?: string;
  model?: string;
  sessionsDir?: string;
  authPath?: string;
  tunnel?: boolean;
  input?: boolean;
}

type StartedService = AgentService & { stateRoot: string; bindHost?: string; port: number };

export async function runStart(dirArg: string, opts: StartOptions): Promise<void> {
  const portFlag = parsePort(opts.port, "--port", "flag");
  const bindFlag = parseBind(opts.bind);
  setLogLevel("info");
  if (isAgentcoreRuntime()) {
    // The generated Runtime resource sets PORT; 8080 is the platform's contract when nothing does.
    const port = portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? 8080;
    let unannounce = (): void => {};
    const deferred = deferAgentcoreService({
      prepare: () => prepareStartWorkspace(dirArg),
      assemble: async (prepared) => {
        const service = await openPreparedWorkspace(prepared, opts);
        await service.ready;
        unannounce = announceControl(service.control, service.stateRoot, { host: bindFlag, tunnel: false }, port);
        return service;
      },
    });
    serve(
      deferred.handler,
      { port, host: bindFlag },
      {
        // The assembly report waits for the first envelope, so this line is the only sign of life a
        // booted container gives — an empty log otherwise reads the same as a container that died.
        onListening: (port) => {
          for (const line of readyAddressLines(bindFlag, port, false)) log.info(line);
          log.info("[fastagent] agentcore: the definition opens on the first invocation");
        },
        onShutdown: async () => {
          unannounce();
          await deferred.close();
        },
      },
    );
    return;
  }
  // Deployed storage refusals (no mount, a held lease, a missing `flock`, a failed install) are the
  // operator's only clue in a crash-looping container; they must not arrive as a Node stack trace.
  const service = await openStartService(dirArg, opts).catch(failStartup);
  const tunnel = opts.tunnel ?? false;
  const host = resolveBindHost(bindFlag, service.bindHost, tunnel);
  serveService(
    service,
    { port: portFlag ?? parsePort(process.env.PORT, "PORT env", "env") ?? service.port, host },
    { tunnel, agentDir: service.agentDir, stateRoot: service.stateRoot },
  );
}

/** What the storage stage hands the opening stage. */
export interface PreparedWorkspace {
  /** The workspace to open — the volume's `base/` when a release manifest selected one. */
  dir: string;
  /** Set when this process took a deployed workspace. */
  deployed?: { root: string; agent: string };
}

/**
 * Stage one — TAKE the workspace: verify the storage is mounted, apply the release, and point the
 * machinery at the volume.
 *
 * It starts nothing, and on failure it holds nothing (`prepareDeployment` releases its lease before
 * it throws), so a caller may retry it. AgentCore does, per envelope: an unmounted volume and a
 * lease the outgoing session still holds are exactly the failures that clear on their own.
 */
export async function prepareStartWorkspace(dirArg: string): Promise<PreparedWorkspace> {
  const manifestPath = process.env.FASTAGENT_RELEASE_FILE;
  if (!manifestPath) return { dir: dirArg };
  const storage = process.env.FASTAGENT_STORAGE_DIR;
  if (!storage) throw new Error("FASTAGENT_STORAGE_DIR is required for a deployed workspace");
  const root = resolve(storage);
  const manifest = parseDeploymentRelease(await readFile(manifestPath, "utf8"));
  const dir = await prepareDeployment(resolve(dirArg), root, manifest);
  // Defaults, not overrides: an operator who pointed either dir somewhere else meant it, and
  // silently relocating their state is the one failure they could not diagnose from the logs.
  process.env.FASTAGENT_STATE_DIR ||= join(root, ".state");
  process.env.FASTAGENT_SECRETS_DIR ||= join(root, ".secrets");
  process.env.FASTAGENT_AGENT = manifest.agent;
  process.chdir(dir);
  return { dir, deployed: { root, agent: manifest.agent } };
}

/**
 * Stage two — RUN in the prepared workspace: install the agent's dependencies, then open through the
 * workspace's own FastAgent install. Mounts channels and starts the scheduler, so it runs at most
 * once per process.
 */
export async function openPreparedWorkspace(prepared: PreparedWorkspace, opts: StartOptions): Promise<StartedService> {
  let open = openPreparedStartService;
  if (prepared.deployed) {
    const { root, agent } = prepared.deployed;
    const agentDir = join(prepared.dir, agent);
    if (await exists(join(agentDir, "package.json"))) {
      const installing = join(root, ".deployment", "installing");
      // A failed install can leave the CLI link in place before its dependencies are complete.
      if ((await exists(installing)) || !(await exists(join(agentDir, "node_modules/.bin/fastagent")))) {
        const { runtime, hasLockfile } = detectRuntime(agentDir, await readPackageJson(agentDir));
        const args =
          runtime === "bun"
            ? ["install", ...(hasLockfile ? ["--frozen-lockfile"] : [])]
            : [hasLockfile ? "ci" : "install"];
        writeFileAtomic(installing, "");
        log.info(`[fastagent] installing the agent's dependencies (${runtime} ${args.join(" ")})…`);
        // stdio inherited: a five-minute install with no output reads as a hang, and the default
        // 1 MB capture would kill a noisy one outright.
        const [code, signal] = (await once(
          spawn(runtime === "bun" ? "bun" : "npm", args, { cwd: agentDir, stdio: "inherit" }),
          "exit",
        )) as [number | null, NodeJS.Signals | null];
        if (code !== 0) throw new Error(`dependency install failed (${signal ?? `exit ${code}`})`);
        await rm(installing);
      }
      // Tools and their session context must share the workspace's runtime module instance.
      const entry = createRequire(join(agentDir, "package.json")).resolve("@fastagent-sh/fastagent");
      const local = (await import(
        new URL("./cli/commands/start.js", pathToFileURL(entry)).href
      )) as typeof import("./start.ts");
      // A version-skewed dependency resolves and imports fine, then fails as "open is not a function"
      // with nothing naming the two versions.
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

/**
 * Internal entry loaded from the active workspace's installed package after storage initialization.
 *
 * REJECTS rather than exiting: on AgentCore this runs as the `assemble` stage of an envelope already
 * in flight, where the deferred service turns a failure into the probe's structured verdict. The
 * CLI's own `.catch(failStartup)` sits at `runStart`, so a local `start` still prints one line.
 */
export async function openPreparedStartService(dirArg: string, opts: StartOptions): Promise<StartedService> {
  const placement = await enterAgentCommand(dirArg, opts);
  await maybeSeedAuth(resolveAuthPath(placement.agentDir, opts.authPath));
  const opened = await createPiAgentFromDir(placement.workspace, {
    model: opts.model,
    sessionsDir: resolveSessionsDirOverride(opts.sessionsDir),
    authPath: opts.authPath,
    serving: true,
  });
  const { agent, agentDir, config, stateRoot, sessionsDir } = opened;
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
  const onStateReady = isAgentcoreRuntime() && config.selfSchedule ? armWakeAlarms(stateRoot) : undefined;
  const service = await (isAgentcoreRuntime()
    ? mountAgentcoreService(opened, { wrapAgent: () => traced, onStateReady })
    : mountAgentService(
        opened,
        cliMountOptions(() => traced),
      ));
  return { ...service, stateRoot, bindHost: config.http?.host, port: config.http?.port ?? 8787 };
}

async function maybeSeedAuth(authPath: string): Promise<void> {
  const bytes = authSeedBytes(collectAuthSeed(process.env), await exists(authPath));
  if (!bytes) return;
  await ensureSecretsDir(dirname(authPath));
  writeFileAtomic(authPath, bytes, SECRET_FILE_MODE);
  log.info(`[fastagent] seeded ${authPath} from FASTAGENT_AUTH_SEED (first boot)`);
}

function armWakeAlarms(stateRoot: string): (() => void) | undefined {
  const secret = process.env.FASTAGENT_WAKE_SECRET;
  if (!secret) {
    log.warn("[fastagent] FASTAGENT_WAKE_SECRET is missing; external wake alarms cannot be registered");
    return undefined;
  }
  const sink = createWakeAlarmSink({ secret });
  setWakeupsSink(sink);
  return () => sink(stateRoot);
}
