/** Production serving. */
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as Effect from "effect/Effect";
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
        // The assembly report waits for the first envelope, so this line is the only sign of life a booted container
        // gives.
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
  // Deployed storage refusals (no mount, a held lease, a missing `flock`, a failed install) are the operator's only
  // clue in a crash-looping container.
  const service = await openStartService(dirArg, opts).catch(failStartup);
  const tunnel = opts.tunnel ?? false;
  // No fallback: this is the container posture, so an unset bind stays the wildcard a published port needs.
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
 * Stage one — TAKE the workspace: verify the storage is mounted, apply the release, and point the machinery at the
 * volume.
 */
export async function prepareStartWorkspace(dirArg: string): Promise<PreparedWorkspace> {
  const manifestPath = process.env.FASTAGENT_RELEASE_FILE;
  if (!manifestPath) return { dir: dirArg };
  const storage = process.env.FASTAGENT_STORAGE_DIR;
  if (!storage) throw new Error("FASTAGENT_STORAGE_DIR is required for a deployed workspace");
  const root = resolve(storage);
  const manifest = parseDeploymentRelease(await readFile(manifestPath, "utf8"));
  const dir = await prepareDeployment(resolve(dirArg), root, manifest);
  // Defaults, not overrides: an operator who pointed either dir somewhere else meant it, and silently relocating
  // their state is the one failure they could not diagnose from the logs.
  process.env.FASTAGENT_STATE_DIR ||= join(root, ".state");
  process.env.FASTAGENT_SECRETS_DIR ||= join(root, ".secrets");
  process.env.FASTAGENT_AGENT = manifest.agent;
  // The release's own answer for the one chain (`flag > environment > config`), projected into the environment it was
  // resolved FOR. `||=`, so a variable the platform already holds still wins — the deployment declares the half of
  // this environment it can, and never more.
  const platformModel = process.env.FASTAGENT_MODEL;
  if (manifest.model) process.env.FASTAGENT_MODEL ||= manifest.model;
  // Both of these land BEFORE the workspace's own `.env` is read, so either one outranks a FASTAGENT_MODEL edited on
  // the box — and an operator who edits that file and restarts has no other way to see why nothing changed. Report
  // the source that actually won, because the remedy differs: a redeploy replaces the manifest's answer and does
  // nothing at all to a platform-set variable.
  if (process.env.FASTAGENT_MODEL) {
    log.info(
      `[fastagent] model ${process.env.FASTAGENT_MODEL} — from ${
        platformModel
          ? `a FASTAGENT_MODEL already set in this environment${
              // Only claim it beat the manifest when the manifest actually named one; otherwise a redeploy would
              // look like the remedy for a value no deployment ever declared.
              manifest.model ? ", which outranks the release manifest" : ""
            }`
          : "the release manifest (redeploy to change it)"
      }; editing FASTAGENT_MODEL in this workspace's .env does not override it`,
    );
  }
  process.chdir(dir);
  return { dir, deployed: { root, agent: manifest.agent } };
}

/**
 * Stage two — RUN in the prepared workspace: install the agent's dependencies, then open through the workspace's own
 * FastAgent install.
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
        // stdio inherited: a five-minute install with no output reads as a hang, and the default 1 MB capture would
        // kill a noisy one outright.
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

/** Internal entry loaded from the active workspace's installed package after storage initialization. */
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
