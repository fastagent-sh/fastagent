/**
 * Chat: open a workspace into pi's interactive TUI (`fastagent chat`). A pi-specific COMMAND, not an
 * engine-neutral channel: it drives pi's full session API (InteractiveMode) for fidelity, so it lives
 * under engines/pi/ and is not re-exported.
 *
 * FIDELITY: chat must run the SAME agent dev/start serve, not pi's vanilla discovery (which would walk
 * AGENTS.md up to the repo root and discover skills from pi's own global dirs). So fastagent's
 * assembly is INJECTED into pi's session:
 *   - prompt  → systemPromptOverride = base + instructions ONLY; pi appends the skill section and env
 *               (cwd) itself (including it here would duplicate it).
 *   - skills  → skillsOverride (fastagent's skills, for the section + invocation).
 *   - tools   → default coding tools by NAME (pi rebuilds them cwd-bound for rich rendering) +
 *               fastagent's custom tools via pi's customTools path (so they survive /new, /resume, fork).
 *
 * Cross-workspace session switches are rejected: `.env` is process-global, so one chat TUI is one
 * workspace.
 *
 * AUTH: chat is the one command that does NOT use fastagent's credential file. It drives pi's own
 * session services (`createAgentSessionServices`, auth from pi's `~/.pi` via `getAgentDir()`), so you
 * log in through pi's TUI, not `fastagent login`. `--auth-path`/`FASTAGENT_AUTH_PATH` therefore do not
 * apply here, and `createPiModels()` below is used only to RESOLVE the model descriptor (never for auth).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  InteractiveMode,
  SessionManager,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveAgentDir, resolveModel, resolveModelSpec } from "./config.ts";
import { assembleSystemPrompt, piBasePrompt, piDefaultTools, resolveTools } from "./create.ts";
import { createPiModels } from "./models.ts";
import { canonicalPath, loadAgentDefinition } from "./definition.ts";
import { isDeferredTool, loadTools, mergeDiscoveredTools } from "./tool.ts";
import { withSearchTool } from "./search-tools.ts";
import { type ToolActivation, additiveActivation, turnContext } from "./tool-context.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "./report.ts";

export interface RunPiChatOptions {
  /** Model spec override (the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
}

/**
 * Build pi's interactive runtime driven by fastagent's assembled agent (model, prompt, tools,
 * skills resolved exactly as the dev opener does). Split from {@link runPiChat} so the assembly —
 * the fidelity-critical part — is inspectable without launching the TUI.
 */
export async function buildChatRuntime(
  dir: string,
  options: RunPiChatOptions = {},
  /** Session backend. Defaults to pi's project-scoped store; tests inject SessionManager.inMemory(). */
  sessionManager?: SessionManager,
): Promise<AgentSessionRuntime> {
  /** The turn's {@link ToolActivation} over pi's AgentSession — the chat counterpart of invoke.ts's
   *  harness bridge, so the SAME builtin search_tools serves both paths. Additive; unknown names
   *  filtered (`setActiveToolsByName` is authoritative on the session and rebuilds its prompt — our
   *  static override keeps the prompt identical to serving). */
  function chatToolActivation(session: AgentSession): ToolActivation {
    return {
      active: () => session.getActiveToolNames(),
      registered: () => session.getAllTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
      async activate(names) {
        const current = session.getActiveToolNames();
        const added = additiveActivation(
          session.getAllTools().map((t) => t.name),
          current,
          names,
        );
        if (added.length > 0) session.setActiveToolsByName([...current, ...added]);
        return added;
      },
    };
  }

  async function resolveAssembly(cwd: string) {
    const { config } = await loadConfig(cwd);
    const modelSpec = resolveModelSpec(options.model, config);
    if (!modelSpec) {
      throw new Error(
        `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
      );
    }
    // Resolution only — the Models' auth is unused here; chat's auth is pi's own (~/.pi via the session
    // services), so authPath is intentionally not threaded in. See the AUTH note in the header.
    const model = resolveModel(createPiModels(), modelSpec);
    const env = new NodeExecutionEnv({ cwd });
    // Same agentDir/cwd split as dev/start: persona/skills/tools from agentDir, ② context walked from cwd.
    const agentDir = resolveAgentDir(cwd, config);
    const definition = await loadAgentDefinition(agentDir, { cwd, env });
    reportDefinitionWarnings(definition.collisions, definition.diagnostics);

    // Same tool resolution as the dev opener, then split: defaults go to pi by NAME (rebuilt cwd-bound
    // for rich rendering); customs go through pi's `customTools` path so they survive /new, /resume, fork.
    const discovered = await loadTools(agentDir);
    const merged = mergeDiscoveredTools(resolveTools(config, cwd), discovered.tools);
    // Chat EMULATES deferral, like serving (what you iterate is what you serve): the builtin loader
    // mounts when a deferred tool exists, the initial active set excludes deferred tools (applied on
    // the session in createRuntime below — pi's TUI session starts all-active), and the activation
    // bridge below rides the same turn context the serving path uses, so the SAME search_tools works
    // against pi's AgentSession instead of fastagent's harness.
    const tools = withSearchTool(merged.tools);
    const crossCollisions = merged.collisions;
    reportToolCollisions([...discovered.collisions, ...crossCollisions]);
    reportModuleLoadFailures(discovered.failures);
    const defaultNames = piDefaultTools(cwd).map((t) => t.name);
    const customTools = tools.filter((t) => !defaultNames.includes(t.name));
    // Adapt fastagent's AgentTool to pi's ToolDefinition (`parameters` is plain JSON-Schema; pi accepts
    // it). Each execute runs inside the turn context with the CURRENT session's activation bridge — the
    // assembly is memoized across /new//resume/fork rebuilds while the session changes, so the bridge
    // resolves through sessionRef at call time, exactly like the serving path resolves its harness.
    const customToolDefs = customTools.map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description ?? "",
      parameters: t.parameters,
      execute: (id: string, params: unknown, signal: AbortSignal | undefined) => {
        const session = sessionRef.current;
        if (!session) return t.execute(id, params, signal);
        return turnContext.run(
          { session: session.sessionId, tools: chatToolActivation(session) },
          () => t.execute(id, params, signal) as Promise<unknown>,
        );
      },
    })) as unknown as ToolDefinition[];

    // base + instructions ONLY — pi appends the skill section and env (cwd) itself (including
    // them here would duplicate them).
    const systemPrompt = assembleSystemPrompt({
      base: piBasePrompt({ tools, persona: definition.persona }),
      contextFiles: definition.contextFiles,
    });

    return { model, definition, defaultNames, customTools, customToolDefs, systemPrompt };
  }

  // pi calls the factory again on /new, /resume, switch, and fork. Config/tools dynamic imports are
  // ESM-cached, so treating same-cwd rebuilds as hot reload would yield a half-fresh agent (fresh
  // AGENTS.md/skills, stale config/tools). Keep chat a coherent startup snapshot: restart to load
  // edits. And keep it workspace-scoped — `.env` is process-global, so a switch to another cwd would
  // leak env or require mutating global env at runtime.
  const rootCwd = canonicalPath(dir);
  // The CURRENT pi session — rebuilt on /new//resume/fork while the memoized assembly (and its tool
  // execute closures) stays; the activation bridge reads it at call time.
  const sessionRef: { current?: AgentSession } = {};
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
    const { model, definition, defaultNames, customTools, customToolDefs, systemPrompt } = await assemblyFor(cwd);

    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: {
        // Definition-only, like dev/start: suppress pi's machine-global discovery (the developer's own
        // ~/.pi extensions, slash commands, global AGENTS.md, APPEND_SYSTEM.md) so chat runs the same
        // agent that gets served, not the authoring machine's pi setup on top.
        noExtensions: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPromptOverride: () => systemPrompt,
        appendSystemPromptOverride: () => [],
        // Replace pi's discovered skills with fastagent's. fastagent's Skill (content inline) is
        // reshaped to pi-coding-agent's (read from filePath/baseDir at invocation time).
        skillsOverride: (base) => ({
          skills: definition.skills.map((s) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
            baseDir: dirname(s.filePath),
            sourceInfo: {
              path: s.filePath,
              source: "fastagent",
              scope: "project",
              origin: "top-level",
              baseDir: dirname(s.filePath),
            },
            disableModelInvocation: s.disableModelInvocation ?? false,
          })) as typeof base.skills,
          diagnostics: base.diagnostics,
        }),
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      tools: [...defaultNames, ...customTools.map((t) => t.name)],
      customTools: customToolDefs,
    });
    sessionRef.current = result.session;
    // Deferral emulation: pi's TUI session starts with everything active — narrow it by SUBTRACTING
    // the deferred names from whatever is active (robust to pi mounting tools of its own; an
    // exact-set-equality gate would silently stop narrowing the day pi adds one). Applied on EVERY
    // build including /resume: pi's chat session does not record activations (its SessionContext has
    // no activeToolNames), so "restore prior activations" is not implementable here — deferral stays
    // consistently ON and a resumed conversation re-discovers via search_tools (documented divergence
    // from serving, where activations persist in the session).
    const deferredNames = customTools.filter(isDeferredTool).map((t) => t.name);
    if (deferredNames.length > 0) {
      const active = result.session.getActiveToolNames();
      if (deferredNames.some((n) => active.includes(n))) {
        result.session.setActiveToolsByName(active.filter((n) => !deferredNames.includes(n)));
      }
    }
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
    `fastagent chat is workspace-scoped: cannot switch to ${targetCwd}; run \`fastagent chat ${targetCwd}\` instead`,
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
 * Keep resume/import inside the chat's single workspace, deciding BEFORE delegating to pi. The chat
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

/**
 * Open the workspace's agent in pi's interactive TUI and run until the user exits. The agent is
 * fastagent's assembled agent (same model/tools/skills/prompt as dev/start serve); pi's TUI handles
 * login, rendering, and same-workspace sessions natively.
 */
export async function runPiChat(dir: string, options: RunPiChatOptions = {}): Promise<void> {
  const runtime = await buildChatRuntime(dir, options);
  await new InteractiveMode(runtime, {}).run();
}
