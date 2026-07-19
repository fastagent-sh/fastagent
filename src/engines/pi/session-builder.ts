/**
 * The shared definition-aware session builder: open a workspace's assembled agent as a resident pi
 * `AgentSessionRuntime`. Extracted from chat.ts (session-control Phase 0) so the TUI is ONE consumer
 * of it and the future serving session-control plane is another — both must run the SAME agent that
 * `dev`/`start` serve.
 *
 * FIDELITY: pi's vanilla discovery (AGENTS.md walk to repo root, machine-global skills/extensions)
 * is suppressed; fastagent's assembly is INJECTED into pi's session:
 *   - prompt  → systemPromptOverride = base + instructions ONLY; pi appends the skill section and env
 *               (cwd) itself (including it here would duplicate it).
 *   - skills  → skillsOverride (fastagent's skills, for the section + invocation).
 *   - tools   → default coding tools by NAME (pi rebuilds them cwd-bound for rich rendering) +
 *               fastagent's custom tools via pi's customTools path (so they survive /new, /resume, fork).
 *   - models  → a ModelRuntime with builtins only (`modelsPath: null`, no availability network), so
 *               the model surface equals serving's `createPiModels()` — pi's machine-global
 *               models.json does not leak in.
 *   - auth    → fastagent's credential store at the workspace auth path (same resolution as the
 *               serving opener: `--auth-path`/`FASTAGENT_AUTH_PATH`, else `<stateRoot>/auth.json`).
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
import { dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./config.ts";
import { assembleSystemPrompt, piBasePrompt, piDefaultTools } from "./create.ts";
import { canonicalPath, loadAgentDefinition } from "./definition.ts";
import { createPiModelRuntime } from "./models.ts";
import { log } from "../../log.ts";
import { type ToolActivation, additiveActivation, turnContext } from "./tool-context.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "./report.ts";
import { resolveWorkspaceAssembly } from "./workspace.ts";

export interface BuildSessionRuntimeOptions {
  /** Model spec override (the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /** Credentials file override (the CLI --auth-path flag). Precedence: this > FASTAGENT_AUTH_PATH >
   *  the workspace default `<stateRoot>/auth.json`. */
  authPath?: string;
}

/**
 * Build pi's interactive runtime driven by fastagent's assembled agent (model, prompt, tools,
 * skills, and auth resolved exactly as the serving opener does). Split from the TUI launcher so the
 * assembly — the fidelity-critical part — is inspectable and reusable without launching a TUI.
 */
export async function buildWorkspaceSessionRuntime(
  dir: string,
  options: BuildSessionRuntimeOptions = {},
  /** Session backend. Defaults to pi's project-scoped store; tests inject SessionManager.inMemory(). */
  sessionManager?: SessionManager,
): Promise<AgentSessionRuntime> {
  /** The turn's {@link ToolActivation} over pi's AgentSession — the counterpart of invoke.ts's
   *  harness bridge, so the SAME builtin search_tools serves both paths. Additive; unknown names
   *  filtered (`setActiveToolsByName` is authoritative on the session and rebuilds its prompt — our
   *  static override keeps the prompt identical to serving). */
  function sessionToolActivation(session: AgentSession): ToolActivation {
    // Same serialization as invoke.ts's bridge (there per turn; here per session — interactive turns
    // make per-session equivalent): the read-modify-write below is only race-free while nothing awaits
    // between read and write, and pi's session setters happening to be synchronous today is not a
    // contract worth betting parallel tool batches on. Built ONCE per session (createRuntime), so
    // parallel calls actually share the chain.
    let chain: Promise<string[]> = Promise.resolve([]);
    return {
      active: () => session.getActiveToolNames(),
      registered: () => session.getAllTools().map((t) => ({ name: t.name, description: t.description ?? "" })),
      activate(names) {
        const run = async (): Promise<string[]> => {
          const current = session.getActiveToolNames();
          const added = additiveActivation(
            session.getAllTools().map((t) => t.name),
            current,
            names,
          );
          if (added.length > 0) session.setActiveToolsByName([...current, ...added]);
          return added;
        };
        const result = chain.then(run, run); // run after the predecessor settles, success or failure
        chain = result.catch(() => []); // the caller sees a rejection on `result`; the chain stays usable
        return result;
      },
    };
  }

  async function resolveAssembly(cwd: string) {
    // The shared front half — the SAME config/model-spec/agentDir/tool/auth resolution the serving
    // opener uses (workspace.ts), so the two pi consumption shapes can never drift on what they
    // assemble. `tools` arrives with search_tools applied; deferral is EMULATED below like serving
    // (what you iterate is what you serve): the initial active set excludes deferred tools (applied
    // on the session in createRuntime — pi's session starts all-active), and the activation bridge
    // above rides the same turn context, so the SAME search_tools works against pi's AgentSession
    // instead of fastagent's harness.
    const { config, modelSpec, agentDir, authPath, tools, deferredToolNames, toolCollisions, toolFailures } =
      await resolveWorkspaceAssembly(cwd, options);
    reportToolCollisions(toolCollisions);
    reportModuleLoadFailures(toolFailures);
    // ONE hub owns model resolution AND per-request auth — the ModelRuntime-shaped sibling of
    // serving's createPiModels; see models.ts.
    const modelRuntime = await createPiModelRuntime({ authPath });
    // MIGRATION HINT (deliberate breaking change): chat historically used pi's own `~/.pi` auth;
    // it now reads the workspace credential file like every other command. A user whose workspace
    // auth is empty while pi's old file exists would otherwise hit a bare provider "no credentials"
    // error with nothing pointing at the cause — tell them where their credentials went.
    if ((await modelRuntime.listCredentials()).length === 0 && existsSync(join(getAgentDir(), "auth.json"))) {
      log.warn(
        `[fastagent] no credentials in ${authPath} — this runtime no longer reads pi's ~/.pi auth; ` +
          `run \`fastagent login\` (or /login in the TUI) to store credentials for this workspace`,
      );
    }
    const model = resolveModel(modelRuntime, modelSpec);
    const env = new NodeExecutionEnv({ cwd });
    const definition = await loadAgentDefinition(agentDir, { cwd, env });
    reportDefinitionWarnings(definition.collisions, definition.diagnostics);
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
      // Propagate the execution mode — an activating tool (the builtin loader) declares "sequential"
      // so pi serializes its batch; without this, pi's outer active-set diff double-stamps parallels.
      executionMode: t.executionMode,
      execute: (id: string, params: unknown, signal: AbortSignal | undefined) => {
        const bound = sessionRef.current;
        // Unreachable by construction (createRuntime sets sessionRef before any turn can run a tool).
        // Throw rather than silently run outside the turn context — that would disguise a broken
        // session-lifecycle invariant as a normal out-of-turn call (fail visibly).
        if (!bound) throw new Error("tool executed before its session was built (lifecycle invariant broken)");
        return turnContext.run(
          { session: bound.session.sessionId, tools: bound.activation },
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

    return {
      model,
      modelRuntime,
      // Serving honors config.thinkingLevel (workspace → L2); the resident session must too (fidelity).
      thinkingLevel: config.thinkingLevel,
      definition,
      defaultNames,
      customTools,
      customToolDefs,
      deferredToolNames,
      systemPrompt,
    };
  }

  // pi calls the factory again on /new, /resume, switch, and fork. Config/tools dynamic imports are
  // ESM-cached, so treating same-cwd rebuilds as hot reload would yield a half-fresh agent (fresh
  // AGENTS.md/skills, stale config/tools). Keep the runtime a coherent startup snapshot: restart to
  // load edits. And keep it workspace-scoped — `.env` is process-global, so a switch to another cwd
  // would leak env or require mutating global env at runtime.
  const rootCwd = canonicalPath(dir);
  // The CURRENT pi session + its activation bridge, BOUND TOGETHER — rebuilt on /new//resume/fork
  // while the memoized assembly (and its tool execute closures) stays. The bridge must share the
  // session's lifetime, NOT be rebuilt per tool call (a per-call chain serializes nothing). Note on
  // parallel batches: pi wraps SDK customTools in its own before/after active-set diff, so an
  // activating tool must carry `executionMode: "sequential"` (the builtin loader does) — pi then runs
  // the whole batch serially and the outer diff sees correct snapshots.
  const sessionRef: { current?: { session: AgentSession; activation: ToolActivation } } = {};
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
    const {
      model,
      modelRuntime,
      thinkingLevel,
      definition,
      defaultNames,
      customTools,
      customToolDefs,
      deferredToolNames,
      systemPrompt,
    } = await assemblyFor(cwd);

    const services = await createAgentSessionServices({
      cwd,
      // fastagent's models + auth hub replaces pi's default (~/.pi-backed) one — the auth
      // unification point; see the header.
      modelRuntime,
      resourceLoaderOptions: {
        // Definition-only, like dev/start: suppress pi's machine-global discovery (the developer's own
        // ~/.pi extensions, slash commands, global AGENTS.md, APPEND_SYSTEM.md) so this runtime runs
        // the same agent that gets served, not the authoring machine's pi setup on top.
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
      thinkingLevel,
      tools: [...defaultNames, ...customTools.map((t) => t.name)],
      customTools: customToolDefs,
    });
    sessionRef.current = { session: result.session, activation: sessionToolActivation(result.session) };
    // Deferral emulation: pi's session starts with everything active — narrow it by SUBTRACTING
    // the deferred names from whatever is active (robust to pi mounting tools of its own; an
    // exact-set-equality gate would silently stop narrowing the day pi adds one). Applied on EVERY
    // build including /resume: pi's chat session does not record activations (its SessionContext has
    // no activeToolNames), so "restore prior activations" is not implementable here — deferral stays
    // consistently ON and a resumed conversation re-discovers via search_tools (documented divergence
    // from serving, where activations persist in the session). The deferred SET comes from the shared
    // assembly (one definition of "deferred"), never recomputed here.
    if (deferredToolNames.length > 0) {
      const active = result.session.getActiveToolNames();
      if (deferredToolNames.some((n) => active.includes(n))) {
        result.session.setActiveToolsByName(active.filter((n) => !deferredToolNames.includes(n)));
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
