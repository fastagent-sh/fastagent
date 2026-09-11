/**
 * The shared definition-aware session builder: open a directory's assembled agent as a resident pi
 * `AgentSessionRuntime`, running the SAME agent that `dev`/`start` serve.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { bindPiSession, definitionResourceLoaderOptions, reportExtensionErrors } from "./agent-session-factory.ts";
import { resolveModel } from "./config.ts";
import { assembleSystemPrompt, piBasePrompt } from "./create.ts";
import { canonicalPath, loadAgentDefinition, loadExtensionPaths } from "./definition.ts";
import { createPiModelRuntime } from "./models.ts";
import { reportModuleLoadFailures } from "../../loader.ts";
import { reportFindingsIfChanged, reportToolCollisions } from "./report.ts";
import { resolveAgentAssembly } from "./open.ts";

export interface BuildSessionRuntimeOptions {
  /** Model spec override (the CLI --model flag). */
  model?: string;
  /** Credentials file override (the SDK `authPath` option; the CLI has only `FASTAGENT_AUTH_PATH`). */
  authPath?: string;
}

/**
 * Build pi's interactive runtime driven by fastagent's assembled agent (model, prompt, tools, skills, and auth
 * resolved exactly as the serving opener does).
 */
export async function buildAgentSessionRuntime(
  dir: string,
  options: BuildSessionRuntimeOptions = {},
  sessionManager?: SessionManager,
): Promise<AgentSessionRuntime> {
  async function resolveAssembly(cwd: string) {
    // The shared front half — the SAME placement/config/model-spec/tool/auth resolution the serving opener uses
    // (open.ts).
    const { config, modelSpec, agentDir, authPath, fallbackAuthPath, stateRoot, tools, toolCollisions, toolFailures } =
      await resolveAgentAssembly(cwd, options);
    reportToolCollisions(toolCollisions);
    reportModuleLoadFailures(toolFailures);
    // ONE hub owns model resolution AND per-request auth.
    // The fallback layer travels too: `chat` resolving credentials differently from dev/start/invoke is exactly the
    // divergence the layer exists to remove.
    const modelRuntime = await createPiModelRuntime({
      authPath,
      agentDir,
      stateRoot,
      ...(fallbackAuthPath !== undefined ? { fallbackAuthPath } : {}),
    });
    const env = new NodeExecutionEnv({ cwd });
    const definition = await loadAgentDefinition(agentDir, { cwd, env });
    reportFindingsIfChanged(definition.dir, definition);
    // Assembly-time, like serving's: this whole function is memoized, so the scan and its warnings happen once per
    // runtime rather than per session rebuild (/new, /resume, fork).
    const extensionPaths = await loadExtensionPaths(agentDir, { cwd, env });

    // base + instructions ONLY — pi appends the skill section and env (cwd) itself (including them here would
    // duplicate them).
    const systemPrompt = assembleSystemPrompt({
      base: piBasePrompt({ tools, persona: definition.persona }),
      contextFiles: definition.contextFiles,
    });

    return {
      modelRuntime,
      modelSpec,
      // Serving honors config.thinkingLevel (config → L2); the resident session must too (fidelity).
      thinkingLevel: config.thinkingLevel,
      definition,
      extensionPaths,
      tools,
      systemPrompt,
    };
  }

  // pi calls the factory again on /new, /resume, switch, and fork.
  const rootCwd = canonicalPath(dir);
  let assembly: Promise<Awaited<ReturnType<typeof resolveAssembly>>> | undefined;
  const assemblyFor = (cwd: string) => {
    // Canonical paths: pi's process.cwd() fallback is a realpath, so a symlinked workspace would otherwise mismatch a
    // non-realpath rootCwd.
    const activeCwd = canonicalPath(cwd);
    if (activeCwd !== rootCwd) {
      throw workspaceScopeError(activeCwd);
    }
    assembly ??= resolveAssembly(rootCwd);
    return assembly;
  };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const { modelRuntime, modelSpec, thinkingLevel, definition, extensionPaths, tools, systemPrompt } =
      await assemblyFor(cwd);

    // Per session, NOT memoized with the assembly.
    const services = await createAgentSessionServices({
      cwd,
      // fastagent's models + auth hub replaces pi's default (~/.pi-backed) one — the auth unification point; see the
      // header.
      modelRuntime,
      // Chat's assembly is fixed for the life of the runtime (a rebuild makes a new one), so these read constants.
      resourceLoaderOptions: definitionResourceLoaderOptions({
        systemPrompt: () => systemPrompt,
        skills: () => definition.skills,
        extensionPaths,
      }),
    });
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
      thinkingLevel,
      tools,
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
