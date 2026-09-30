/**
 * The shared definition-aware session builder: open a directory's assembled agent as a resident pi
 * `AgentSessionRuntime`, running the SAME agent that `dev`/`start` serve.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { bindPiSession, definitionResourceLoaderOptions, reportExtensionErrors } from "./agent-session-factory.ts";
import { readMachine } from "./machine.ts";
import { resolveModel } from "./config.ts";
import { canonicalPath } from "./definition.ts";
import { reportToolCollisions } from "./report.ts";
import { assembleFront, resolveAgentAssembly } from "./open.ts";
import { resolvePlacement } from "../../paths.ts";

export interface BuildSessionRuntimeOptions {
  /** Model spec override (the CLI --model flag). */
  model?: string;
  /** Credentials file override (the SDK `authPath` option; the CLI has only `FASTAGENT_AUTH_PATH`). */
  authPath?: string;
}

/**
 * Build pi's interactive runtime over the SAME assembly `dev`/`start` serve ({@link assembleFront}): model
 * registry, prompt, tools, skills, reasoning effort and credentials all come from it, so what differs is only the
 * session's shape (one resident runtime rather than one session per invoke).
 */
export async function buildAgentSessionRuntime(
  dir: string,
  options: BuildSessionRuntimeOptions = {},
  sessionManager?: SessionManager,
): Promise<AgentSessionRuntime> {
  async function resolveAssembly() {
    const front = await resolveAgentAssembly(dir, options);
    reportToolCollisions(front.toolCollisions);
    const { assembly } = await assembleFront(front);
    // Read ONCE per runtime: a rebuild (/new, fork) keeps the startup snapshot, because config and tools stay in the
    // import cache and a half-refreshed agent is worse than a stale one. Restart chat to pick up edits.
    return { modelSpec: front.modelSpec, assembly, definition: await assembly.readDefinition() };
  }

  // The workspace, like serving's: where tools run and what session records are keyed to. Canonical, because pi's
  // process.cwd() fallback is a realpath and a symlinked workspace would otherwise mismatch it.
  const rootCwd = canonicalPath(resolvePlacement(dir).workspace);
  // pi calls the factory again on /new, /resume, switch, and fork; the assembly is built once.
  let assembly: ReturnType<typeof resolveAssembly> | undefined;
  const assemblyFor = (cwd: string) => {
    const activeCwd = canonicalPath(cwd);
    if (activeCwd !== rootCwd) {
      throw workspaceScopeError(activeCwd);
    }
    assembly ??= resolveAssembly();
    return assembly;
  };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const { modelSpec, assembly, definition } = await assemblyFor(cwd);
    // Per session, NOT memoized with the assembly.
    const [modelRuntime, machine] = await Promise.all([assembly.modelRuntime(), readMachine(cwd)]);
    const loaded = await createAgentSessionServices({
      cwd,
      // fastagent's models + auth hub replaces pi's default (~/.pi-backed) one — the auth unification point.
      modelRuntime,
      // PACKAGELESS, for the loader: fastagent never installs a pi package (machine.ts). Handed pi's own settings, the
      // loader resolves `packages` itself — installing a missing one, and failing chat's start when that fails.
      settingsManager: machine.settingsManager(),
      resourceLoaderOptions: definitionResourceLoaderOptions({
        systemPrompt: () => definition.systemPrompt,
        skills: () => definition.skills,
        machine,
        extensionPaths: assembly.extensionPaths,
      }),
    });
    // ...while the SESSION keeps pi's own file-backed settings, so `/settings` in the TUI still saves. pi persists by
    // re-reading the file under its lock and writing only the fields that changed, so `packages` there is untouched.
    const services = { ...loaded, settingsManager: SettingsManager.create(cwd, loaded.agentDir) };
    reportExtensionErrors(services);

    // AFTER the services, because an extension may be what defines the model.
    const model = resolveModel(modelRuntime, modelSpec);
    // The same bind serving performs, minus the activation record: pi's chat session has nowhere to put one, which is
    // the documented divergence.
    const result = await bindPiSession({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      // Always set, never left for pi to fill: pi resolves an ABSENT level from the machine's settings, and the effort
      // is the definition's (`thinkingLevel` in fastagent.config.ts), like serving's.
      thinkingLevel: assembly.thinkingLevel,
      tools: assembly.tools,
      // A tool must see one spelling of the workspace, including when opened through a symlink.
      cwd: rootCwd,
      recordActivations: false,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: rootCwd,
    agentDir: getAgentDir(),
    sessionManager: sessionManager ?? SessionManager.create(rootCwd),
  });
  enforceWorkspaceScopedSessionSwitches(runtime, rootCwd);
  return runtime;
}

function workspaceScopeError(targetCwd: string): Error {
  return new Error(
    `fastagent sessions are workspace-scoped: cannot switch to ${targetCwd}; open that workspace instead`,
  );
}

function readSessionHeaderCwd(sessionPath: string): string | undefined {
  const resolvedPath = resolve(sessionPath);
  if (!existsSync(resolvedPath)) return undefined;
  for (const line of readFileSync(resolvedPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
      if (entry.type === "session") return typeof entry.cwd === "string" ? canonicalPath(entry.cwd) : undefined;
    } catch {
      // Ignore malformed lines the same way pi's session loader does; no header cwd → caller pins root.
    }
  }
  return undefined;
}

/** Keep resume/import inside the runtime's single workspace, deciding BEFORE delegating to pi. */
function enforceWorkspaceScopedSessionSwitches(runtime: AgentSessionRuntime, rootCwd: string): void {
  const rejectForeignTarget = (sessionPath: string, cwdOverride: string | undefined): void => {
    const target = cwdOverride !== undefined ? canonicalPath(cwdOverride) : readSessionHeaderCwd(sessionPath);
    if (target !== undefined && target !== rootCwd) throw workspaceScopeError(target);
  };

  const switchSession = runtime.switchSession.bind(runtime);
  runtime.switchSession = async (...args: Parameters<AgentSessionRuntime["switchSession"]>) => {
    rejectForeignTarget(args[0], args[1]?.cwdOverride);
    return switchSession(...args);
  };

  const importFromJsonl = runtime.importFromJsonl.bind(runtime);
  runtime.importFromJsonl = async (...args: Parameters<AgentSessionRuntime["importFromJsonl"]>) => {
    rejectForeignTarget(args[0], args[1]);
    return importFromJsonl(...args);
  };
}
