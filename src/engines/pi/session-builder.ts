/**
 * The shared definition-aware session builder: open a directory's assembled agent as a resident pi
 * `AgentSessionRuntime`. Extracted from chat.ts (session-control Phase 0) as the proof of the
 * assembly seam — independently instantiable, running the SAME agent that `dev`/`start` serve. The
 * TUI (chat.ts) is its one consumer: the session control plane (Phases 1–3) was built on the invoke
 * pipeline instead of this resident runtime, so control-plane observation covers invoke-driven runs
 * and deliberately not chat sessions (design §10/§15).
 *
 * FIDELITY: pi's vanilla discovery (AGENTS.md walk to repo root, machine-global skills/extensions)
 * is suppressed; fastagent's assembly is INJECTED into pi's session:
 *   - prompt  → systemPromptOverride = base + instructions ONLY; pi appends the skill section and env
 *               (cwd) itself (including it here would duplicate it).
 *   - skills  → skillsOverride (fastagent's skills, for the section + invocation).
 *   - tools   → enabled default coding tools by NAME (pi rebuilds them cwd-bound for rich rendering) +
 *               fastagent's custom tools via pi's customTools path (so they survive /new, /resume, fork).
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
import { join, resolve } from "node:path";
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
import { definitionResourceLoaderOptions, reportExtensionErrors } from "./agent-session-factory.ts";
import { resolveModel } from "./config.ts";
import { assembleSystemPrompt, disabledBuiltinNames, piBasePrompt } from "./create.ts";
import { canonicalPath, loadAgentDefinition, loadExtensionPaths } from "./definition.ts";
import { createPiModelRuntime, probeAuthSource } from "./models.ts";
import { log } from "../../log.ts";
import {
  type ReadonlySessionManager,
  type ToolActivation,
  additiveActivation,
  agentSessionManager,
  turnContext,
} from "./tool-context.ts";
import { reportFindingsIfChanged, reportModuleLoadFailures, reportToolCollisions } from "./report.ts";
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
  /** The turn's {@link ToolActivation} over pi's AgentSession — the counterpart of invoke.ts's
   *  serving bridge, so the SAME builtin search_tools serves both paths. Additive; unknown names
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
    // The shared front half — the SAME placement/config/model-spec/tool/auth resolution the serving
    // opener uses (open.ts); those inputs cannot drift between the two consumption shapes.
    // (Definition→prompt assembly is NOT shared: serving re-reads live per invoke, this runtime is a
    // startup snapshot and pi appends skills/env itself — see the header.) `tools` arrives with
    // search_tools applied; deferral is EMULATED below like serving
    // (what you iterate is what you serve): the initial active set excludes deferred tools (applied
    // on the session in createRuntime — pi's session starts all-active), and the activation bridge
    // above rides the same turn context, so the SAME search_tools works against pi's AgentSession
    // instead of the served one.
    const {
      config,
      modelSpec,
      agentDir,
      authPath,
      stateRoot,
      tools,
      codingToolNames,
      deferredToolNames,
      toolCollisions,
      toolFailures,
    } = await resolveAgentAssembly(cwd, options);
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
    // ALL of them, pi's four included: fastagent's `read` is `createReadTool({ imageProcessor })`
    // (create.ts), and letting pi mount its own instead would silently drop image reading in chat.
    // Serving already does it this way. And `tools` is ALREADY the configured surface —
    // resolveTools() applied `codingTools` — so narrowing needs nothing here: what the definition
    // disabled never reaches this list, and pi's own copies stay out via `noTools: "builtin"`.
    const customTools = tools;
    // What the definition turned OFF, for pi to refuse rather than merely leave inactive — minus any
    // name an authored tool has taken (that name is the author's once the built-in is disabled).
    const excludedCodingTools = disabledBuiltinNames(codingToolNames, tools);
    // Adapt fastagent's AgentTool to pi's ToolDefinition (`parameters` is plain JSON-Schema; pi accepts
    // it). Each execute runs inside the turn context with the CURRENT session's activation bridge — the
    // assembly is memoized across /new//resume/fork rebuilds while the session changes, so the bridge
    // resolves through sessionRef at call time, exactly like the serving path resolves its session.
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
          { cwd, sessionManager: bound.sessionManager, tools: bound.activation },
          // pi's per-turn TOOL context (5th parameter) is read only by its default coding tools;
          // fastagent's own take theirs from `turnContext` (AsyncLocalStorage). This env satisfies
          // the shape for both, and is the chat cwd's — the same root pi would have handed them.
          () => t.execute(id, params, signal, undefined, { env }) as Promise<unknown>,
        );
      },
    })) as unknown as ToolDefinition[];

    // base + instructions ONLY — pi appends the skill section and env (cwd) itself (including
    // them here would duplicate them).
    const systemPrompt = assembleSystemPrompt({
      base: piBasePrompt({ tools, persona: definition.persona, codingToolNames }),
      contextFiles: definition.contextFiles,
    });

    return {
      modelRuntime,
      modelSpec,
      authPath,
      // Serving honors config.thinkingLevel (config → L2); the resident session must too (fidelity).
      thinkingLevel: config.thinkingLevel,
      definition,
      extensionPaths,
      customTools,
      customToolDefs,
      excludedCodingTools,
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
  const sessionRef: {
    current?: { session: AgentSession; sessionManager: ReadonlySessionManager; activation: ToolActivation };
  } = {};
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

  // The credential hint belongs to the RUNTIME, not to each session it builds: model resolution
  // moved into createRuntime (extensions must load first), and repeating this on every /new,
  // /resume and fork would nag about a setting that did not change.
  let credentialHintShown = false;
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const {
      modelRuntime,
      modelSpec,
      authPath,
      thinkingLevel,
      definition,
      extensionPaths,
      customToolDefs,
      excludedCodingTools,
      deferredToolNames,
      systemPrompt,
    } = await assemblyFor(cwd);

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
    // own extension with a bare "unknown model", after warning about credentials for a provider
    // that does not exist yet.
    //
    // MIGRATION HINT (deliberate breaking change): chat historically used pi's own `~/.pi` auth; it
    // now reads the agent's credential file like every other command. Probe the RESOLVED model's
    // provider through the normal resolution path (stored credential OR env var — an env-authed
    // user is fine and must not be warned): only when that provider has no usable auth AND pi's old
    // file exists does the bare provider error get its cause named.
    if (
      !credentialHintShown &&
      (await probeAuthSource(modelRuntime, modelSpec)) === undefined &&
      existsSync(join(getAgentDir(), "auth.json"))
    ) {
      credentialHintShown = true;
      log.warn(
        `[fastagent] no credentials for ${modelSpec} in ${authPath} — this runtime no longer reads ` +
          `pi's ~/.pi auth; run \`fastagent login\` (or /login in the TUI) to store credentials for this agent`,
      );
    }
    const model = resolveModel(modelRuntime, modelSpec);

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel,
      // NO `tools` allowlist. It would freeze the tool set at build time, and pi lets an extension
      // register from `session_start`, a command, or any handler — those names would not be in a
      // startup snapshot, so `refreshTools()` would filter them straight back out and the extension
      // would look like it did nothing. `noTools: "builtin"` gets the same guarantee the allowlist
      // was really there for (the machine's `defaultTools` setting cannot add pi's own copies on top
      // of ours) without freezing anything.
      noTools: "builtin",
      // Disabled coding tools are refused at the REGISTRY, not just left inactive: chat has a TUI
      // that can activate a tool by name, so "mounted but inactive" would make `codingTools` a
      // default rather than a boundary.
      ...(excludedCodingTools.length > 0 ? { excludeTools: excludedCodingTools } : {}),
      customTools: customToolDefs,
    });
    sessionRef.current = {
      session: result.session,
      sessionManager: agentSessionManager(result.session, result.session.sessionManager.getSessionId()),
      activation: sessionToolActivation(result.session),
    };
    // NOT bound here: the HOST does it. InteractiveMode.bindCurrentSessionExtensions() calls
    // session.bindExtensions() with the TUI's uiContext, abort handler and command actions — binding
    // here too would emit session_start twice per chat, so an extension opening a resource on start
    // would open two.
    // Deferral emulation: pi starts THIS agent's tools active — its own four default names, which
    // our customTools have replaced, plus every custom and extension tool. (Tools pi mounts but does
    // not activate, like grep/find/ls, stay inactive, which is the same set serving offers.) So
    // narrow by SUBTRACTING the deferred names from whatever is active, rather than stating a set:
    // an exact-set-equality gate would silently stop narrowing the day pi activates one more.
    //
    // Applied on EVERY build including /resume: pi's chat session does not record activations (its
    // SessionContext has no activeToolNames), so "restore prior activations" is not implementable
    // here — deferral stays consistently ON and a resumed conversation re-discovers via search_tools
    // (a documented divergence from serving, where activations persist in the session). The deferred
    // SET comes from the shared assembly (one definition of "deferred"), never recomputed here.
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
