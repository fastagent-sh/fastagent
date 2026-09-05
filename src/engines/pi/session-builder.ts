/**
 * The shared definition-aware session builder: open a directory's assembled agent as a resident pi
 * `AgentSessionRuntime`, running the SAME agent that `dev`/`start` serve. The TUI (chat.ts) is its
 * one consumer: the session control plane was built on the invoke pipeline instead of this resident
 * runtime, so control-plane observation covers invoke-driven runs and deliberately not chat sessions
 * (docs/design/session-control.md §10, §15).
 *
 * FIDELITY: pi's vanilla discovery (AGENTS.md walk to repo root, machine-global skills/extensions)
 * is suppressed; fastagent's assembly is INJECTED into pi's session:
 *   - prompt  → systemPromptOverride = base + instructions ONLY; pi appends the skill section and env
 *               (cwd) itself (including it here would duplicate it).
 *   - skills  → skillsOverride (fastagent's skills, for the section + invocation).
 *   - tools   → all seven coding tools plus authored tools through pi's customTools path; pi's builtin
 *               copies are suppressed, and the injected set survives /new, /resume, and fork.
 *   - models  → a ModelRuntime with builtins only (`modelsPath: null`, no availability network), so
 *               the model surface equals serving's `createPiModels()` — pi's machine-global
 *               models.json does not leak in.
 *   - auth    → fastagent's credential store at the AGENT's auth path (same resolution as the
 *               serving opener: `--auth-path`/`FASTAGENT_AUTH_PATH`, else `<root>/.secrets/auth.json`).
 *               pi's TUI `/login` writes through the injected store into the SAME file, so `fastagent
 *               login` and chat share one credential lifecycle. pi's `~/.pi` auth is not consulted.
 *
 * `getAgentDir()` (pi's `~/.pi`) remains ONLY for presentation-level TUI settings (theme,
 * keybindings) — user preference, not agent definition; no auth or discovery flows from it.
 *
 * Cross-workspace session switches are rejected: `.env` is process-global, so one runtime is one
 * workspace.
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
  /** Model spec override (the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /** Credentials file override (the CLI --auth-path flag). Precedence: this > FASTAGENT_AUTH_PATH >
   *  the agent's default `<agentDir>/.secrets/auth.json`. */
  authPath?: string;
}

/**
 * Build pi's interactive runtime driven by fastagent's assembled agent (model, prompt, tools,
 * skills, and auth resolved exactly as the serving opener does). Split from the TUI launcher so the
 * assembly — the fidelity-critical part — is inspectable and reusable without launching a TUI.
 */
export async function buildAgentSessionRuntime(
  dir: string,
  options: BuildSessionRuntimeOptions = {},
  /** Session backend. Defaults to pi's project-scoped store; tests inject SessionManager.inMemory(). */
  sessionManager?: SessionManager,
): Promise<AgentSessionRuntime> {
  async function resolveAssembly(cwd: string) {
    // The shared front half — the SAME placement/config/model-spec/tool/auth resolution the serving
    // opener uses (open.ts); those inputs cannot drift between the two consumption shapes.
    // Serving re-reads the definition per invoke; chat keeps a startup snapshot. Both pass identity
    // and project context to Pi, which appends skills/cwd. `tools` already includes search_tools.
    const { config, modelSpec, agentDir, authPath, stateRoot, tools, toolCollisions, toolFailures } =
      await resolveAgentAssembly(cwd, options);
    reportToolCollisions(toolCollisions);
    reportModuleLoadFailures(toolFailures);
    // ONE hub owns model resolution AND per-request auth; see models.ts.
    // agentDir carries the agent's own models.json (custom endpoints); stateRoot keeps pi's generated
    // catalog cache out of the definition dir. See createPiModelRuntime.
    const modelRuntime = await createPiModelRuntime({ authPath, agentDir, stateRoot });
    const env = new NodeExecutionEnv({ cwd });
    const definition = await loadAgentDefinition(agentDir, { cwd, env });
    reportFindingsIfChanged(definition.dir, definition);
    // Assembly-time, like serving's: this whole function is memoized, so the scan and its warnings
    // happen once per runtime rather than per session rebuild (/new, /resume, fork).
    const extensionPaths = await loadExtensionPaths(agentDir, { cwd, env });

    // base + instructions ONLY — pi appends the skill section and env (cwd) itself (including
    // them here would duplicate them).
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

  // pi calls the factory again on /new, /resume, switch, and fork. Config/tools dynamic imports are
  // ESM-cached, so treating same-cwd rebuilds as hot reload would yield a half-fresh agent (fresh
  // AGENTS.md/skills, stale config/tools). Keep the runtime a coherent startup snapshot: restart to
  // load edits. And keep it workspace-scoped — `.env` is process-global, so a switch to another cwd
  // would leak env or require mutating global env at runtime.
  const rootCwd = canonicalPath(dir);
  let assembly: Promise<Awaited<ReturnType<typeof resolveAssembly>>> | undefined;
  const assemblyFor = (cwd: string) => {
    // Canonical paths: pi's process.cwd() fallback is a realpath, so a symlinked workspace would
    // otherwise mismatch a non-realpath rootCwd.
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

    // Per session, NOT memoized with the assembly: pi replaces the session on /new, /resume and
    // fork, and its extension contract is that the replacement gets freshly loaded extensions
    // rather than the previous session's objects. The expensive halves (model hub, auth) are shared
    // through the assembly; only the resource loader is rebuilt.
    const services = await createAgentSessionServices({
      cwd,
      // fastagent's models + auth hub replaces pi's default (~/.pi-backed) one — the auth
      // unification point; see the header.
      modelRuntime,
      // Chat's assembly is fixed for the life of the runtime (a rebuild makes a new one), so these
      // read constants — where serving passes accessors that change per turn — and it DOES pass its
      // extension paths: chat runs them.
      resourceLoaderOptions: definitionResourceLoaderOptions({
        systemPrompt: () => systemPrompt,
        skills: () => definition.skills,
        extensionPaths,
      }),
    });
    reportExtensionErrors(services);

    // AFTER the services, because an extension may be what defines the model. `registerProvider()`
    // is pi's documented way for one to add providers, and extensions do not execute until the
    // services are built — resolving first fails a definition whose configured model comes from its
    // own extension with a bare "unknown model".
    const model = resolveModel(modelRuntime, modelSpec);
    // The same bind serving performs, minus the activation record: pi's chat session has nowhere to
    // put one, which is the documented divergence — a resumed chat re-discovers via search_tools.
    // NOT bound to the host here: InteractiveMode.bindCurrentSessionExtensions() calls
    // session.bindExtensions() with the TUI's uiContext, abort handler and command actions — binding
    // here too would emit session_start twice per chat, so an extension opening a resource on start
    // would open two.
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

/**
 * Keep resume/import inside the runtime's single workspace, deciding BEFORE delegating to pi. The
 * process is chdir'd into rootCwd, so a session with no cwd header already lands on rootCwd. The gap
 * is a session that EXPLICITLY records a different cwd: pi would bind it and the factory would reject
 * it — but only AFTER tearing the live session down. Reject such a switch up front.
 */
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
