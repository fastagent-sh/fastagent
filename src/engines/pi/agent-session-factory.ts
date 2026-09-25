/**
 * The AgentSession L0's engine binding: fastagent's assembled agent — model, prompt, skills, tools — bound to one
 * durable record, per invoke.
 */
import { dirname } from "node:path";
import { type Machine, type MachineSkill, readMachine, withMachine } from "./machine.ts";
import type { Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionServices,
  type CompactionResult,
  type CreateAgentSessionServicesOptions,
  type ExtensionCommandContextActions,
  type InlineExtension,
  ExtensionRunner,
  type LoadExtensionsResult,
  ModelRegistry,
  type ModelRuntime,
  type ResolvedCommand,
  SessionManager,
  type ToolDefinition,
  DefaultResourceLoader,
  createAgentSessionFromServices,
  getAgentDir,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import { log } from "../../log.ts";
import type { PiSessionRecordStore } from "./session-store.ts";
import { isDeferredTool, type MountedTool } from "./tool.ts";
import { activePath, resolveSessionSettings } from "./session-settings.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL } from "./models.ts";
import { type TurnContext, agentSessionManager, sessionToolActivation, turnContext } from "./tool-context.ts";

interface PiSessionDefinition {
  systemPrompt?: string;
  skills: Skill[];
}

export interface PiAgentSessionFactoryOptions {
  /** Where conversations live. */
  sessions: PiSessionRecordStore;
  /** The model to run and the hub that authenticates it, resolved on FIRST USE and kept. */
  engine: () => Promise<{ modelRuntime: ModelRuntime; model: AnyModel }>;
  thinkingLevel?: ThinkingLevel;
  tools?: MountedTool[];
  /** Read once per binding; prompt and skills come from the same definition read. */
  readDefinition: () => PiSessionDefinition | Promise<PiSessionDefinition>;
  /** The agent's working directory — what fastagent-defined tools see as `cwd`. */
  cwd: string;
  /** The definition's own extension entry points, loaded fresh for every bound session. */
  extensionPaths?: string[];
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
}

/**
 * The session custom-entry type recording ONE activation delta: `{ names }` — exactly the deferred tools a loader
 * activated in that call.
 *
 * Not replaceable by pi's own transcript record. Since 0.86 the journal carries `toolsAdded` system messages and
 * `getCurrentTools()` replays them, but that answers a different question: it reports every tool ever DECLARED to
 * the model, which cannot tell a tool this conversation DISCOVERED from one that merely happened to be in the
 * initial set at the time. Restoring from it would keep a tool later flipped to `deferred` active in sessions that
 * never discovered it. This entry holds only what a loader activated, which is what makes the restore below
 * "today's non-deferred tools PLUS what this conversation found".
 */
const TOOL_ACTIVATION_ENTRY = "fastagent:tool-activation";

/** Every deferred tool this session has ever discovered, oldest first. */
function recordedActivations(session: AgentSession): string[] {
  const names: string[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    const record = entry as { type?: string; customType?: string; data?: { names?: unknown } };
    if (record.type !== "custom" || record.customType !== TOOL_ACTIVATION_ENTRY) continue;
    if (Array.isArray(record.data?.names)) {
      for (const name of record.data.names) if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/**
 * Warned once per session+missing set: a fresh session is built per invoke and channel sessions run for weeks, so an
 * un-deduped warn would repeat every turn and dilute its own signal.
 */
const warnedDroppedActivations = new Set<string>();

type ToolBinding = { session: AgentSession; context: TurnContext };

/** fastagent's tools as pi tool definitions, bound to ONE session. */
function toolDefinitions(tools: MountedTool[], bound: { current?: ToolBinding }, sessionId: string): ToolDefinition[] {
  return tools.map(
    (tool): ToolDefinition => ({
      ...tool,
      label: tool.label || tool.name,
      execute: (id, params, signal, onUpdate, ctx) => {
        const binding = bound.current;
        if (!binding) throw new Error("tool executed before its turn context was bound (lifecycle invariant broken)");
        const { session, context } = binding;
        // Expose the caller's id rather than Pi's filename encoding.
        const sessionManager = Object.create(ctx.sessionManager, {
          getSessionId: { value: () => sessionId },
          getHeader: {
            value: () => {
              const header = ctx.sessionManager.getHeader();
              return header ? { ...header, id: sessionId } : header;
            },
          },
        });
        // Pi's thinking getter uses a shared runtime; a restored cwd may be a symlink spelling.
        const scoped = Object.create(ctx, {
          sessionManager: { value: sessionManager },
          cwd: { value: context.cwd },
          thinkingLevel: { get: () => session.thinkingLevel },
        });
        return turnContext.run(context, () => tool.execute(id, params, signal, onUpdate, scoped));
      },
    }),
  );
}

export interface BindPiSessionOptions {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  /** Chat only: pi's runtime hands the resumed/new session its start event. */
  sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];
  model: AnyModel;
  thinkingLevel: ThinkingLevel | undefined;
  tools: MountedTool[];
  /** The agent's working directory — what fastagent-defined tools see as `cwd`. */
  cwd: string;
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
  /** The CALLER's session id — what a tool asking which conversation it is in hears. */
  sessionId?: string;
  /** Record each discovered activation on the session, so the next bind restores it. */
  recordActivations: boolean;
}

/**
 * Bind ONE pi session to a record: the definition's tools as pi definitions over one turn context, pi's own tool
 * copies kept off, and deferral applied.
 */
export async function bindPiSession(options: BindPiSessionOptions): ReturnType<typeof createAgentSessionFromServices> {
  const { services, sessionManager, model, thinkingLevel, tools, cwd, recordActivations } = options;
  const excludedToolNames = options.excludedToolNames ?? [];
  const deferred = tools.filter(isDeferredTool).map((t) => t.name);
  const bound: { current?: ToolBinding } = {};
  const sessionId = options.sessionId ?? sessionManager.getSessionId();
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
    model,
    thinkingLevel,
    // pi would otherwise mount its built-ins on top of fastagent's copies, offering duplicate names.
    noTools: "builtin",
    ...(excludedToolNames.length > 0 ? { excludeTools: [...excludedToolNames] } : {}),
    customTools: toolDefinitions(tools, bound, sessionId),
  });
  const { session } = result;
  // One context for the whole session: it describes the SESSION, not the call.
  bound.current = {
    session,
    context: {
      cwd,
      sessionManager: agentSessionManager(session, sessionId),
      // Persist each discovery so a served session can restore it on its next turn.
      tools: sessionToolActivation(
        session,
        recordActivations
          ? (added) => session.sessionManager.appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: added })
          : undefined,
      ),
    },
  };
  // Deferral, then restoration: pi starts every mounted tool active, so narrow by SUBTRACTING the deferred names
  // (robust to pi mounting tools of its own, unlike an exact-set replacement), then add back what THIS session has
  // already discovered.
  if (deferred.length > 0) {
    const active = session.getActiveToolNames();
    const mounted = new Set(session.getAllTools().map((tool) => tool.name));
    const recorded = recordActivations ? recordedActivations(session) : [];
    // A recorded name that is no longer mounted is dropped rather than replayed.
    const restored = recorded.filter((name) => mounted.has(name));
    const dropped = recorded.filter((name) => !mounted.has(name));
    if (dropped.length > 0) {
      const key = `${sessionId}\u0000${[...new Set(dropped)].sort().join(",")}`;
      const emit = warnedDroppedActivations.has(key) ? log.debug : log.warn;
      warnedDroppedActivations.add(key);
      emit(
        `[fastagent] session ${sessionId}: dropping recorded activation(s) no longer mounted: ${[...new Set(dropped)].join(", ")}`,
      );
    }
    const next = [...new Set([...active.filter((name) => !deferred.includes(name)), ...restored])];
    if (next.length !== active.length || next.some((name) => !active.includes(name))) {
      session.setActiveToolsByName(next);
    }
  }
  return result;
}

/** Each distinct load failure is said once per process: serving loads the extensions again for every session. */
const reportedExtensionErrors = new Set<string>();

/**
 * Announce extensions pi failed to load. pi collects them into `LoadExtensionsResult.errors` and carries on with the
 * rest.
 */
export function reportExtensionErrors(services: AgentSessionServices): void {
  for (const { path, error } of services.resourceLoader.getExtensions().errors) {
    const key = `${path}\u0000${error}`;
    if (reportedExtensionErrors.has(key)) continue;
    reportedExtensionErrors.add(key);
    log.warn(`[fastagent] extension ${path} failed to load: ${error}`);
  }
}

const PROVIDER_REFUSAL =
  "extensions cannot register model providers when serving: a provider is process-wide, shared by every " +
  "conversation, and never unregistered. Declare it in the agent's models.json";

/**
 * Serving refuses an extension that registers a provider while loading. pi would write it into the ONE `ModelRuntime`
 * every conversation resolves against, merge a re-registration into the old entry, and never drop one the code stopped
 * registering. The whole extension is left out, the way a tool file that fails to load is, and the refusal is its
 * load error.
 */
function refuseLoadTimeProviders(base: LoadExtensionsResult): LoadExtensionsResult {
  const offenders = new Set([
    ...base.runtime.pendingProviderRegistrations.map((r) => r.extensionPath),
    ...base.runtime.pendingNativeProviderRegistrations.map((r) => r.extensionPath),
  ]);
  if (offenders.size === 0) return base;
  base.runtime.pendingProviderRegistrations = [];
  base.runtime.pendingNativeProviderRegistrations = [];
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !offenders.has(extension.path)),
    errors: [...base.errors, ...[...offenders].map((path) => ({ path, error: PROVIDER_REFUSAL }))],
  };
}

/**
 * ...and a registration made AFTER loading (from an event handler or a command), which pi applies to the shared
 * runtime directly. Must run after the session is created (pi installs its own actions then) and before
 * `bindExtensions` (which fires `session_start`).
 */
function refuseLateProviders(services: AgentSessionServices): void {
  const runtime = services.resourceLoader.getExtensions().runtime;
  const refuse = (): never => {
    throw new Error(PROVIDER_REFUSAL);
  };
  runtime.registerProvider = refuse;
  runtime.registerNativeProvider = refuse;
  runtime.unregisterProvider = refuse;
}

/**
 * What a command's `ctx` can do to the session when serving. Each turn binds its own session and disposes it, so
 * there is no current session to replace, fork or reload; pi's unbound default would report `{ cancelled: false }`
 * for all of them without doing anything.
 */
function servingCommandActions(session: AgentSession): ExtensionCommandContextActions {
  const unavailable = (action: string) => async (): Promise<never> => {
    throw new Error(`ctx.${action}() is not available when serving: every turn runs on its own session`);
  };
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: unavailable("newSession"),
    fork: unavailable("fork"),
    navigateTree: unavailable("navigateTree"),
    switchSession: unavailable("switchSession"),
    reload: unavailable("reload"),
  };
}

/** What pi is allowed to discover, minus the parts each assembly fills in itself. */
type DefinitionLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/** The resource posture a fastagent definition asks pi for — ONE definition of it, for both assemblies. */
export function definitionResourceLoaderOptions(source: {
  systemPrompt: () => string | undefined;
  skills: () => Skill[];
  /** {@link readMachine} for this workspace — resolved by the caller, because this function is synchronous. */
  machine: Machine;
  extensionPaths?: readonly string[];
}): DefinitionLoaderOptions {
  return {
    // The machine's extensions are its owner's setup, not this agent's.
    noExtensions: true,
    // ...except the definition's OWN extensions/: pi honours additionalExtensionPaths even under noExtensions, which
    // is exactly the split wanted here.
    ...(source.extensionPaths?.length ? { additionalExtensionPaths: [...source.extensionPaths] } : {}),
    // Not pi's: fastagent already loads the SAME files into segment ② (`loadProjectContextFiles` in
    // definition.ts). Leaving both on would put every AGENTS.md in the prompt twice.
    noContextFiles: true,
    // The IDENTITY is the definition's, whatever the machine thinks. Inheriting skills is inheriting capability;
    // inheriting a system prompt would be the agent becoming someone else's agent.
    systemPromptOverride: () => source.systemPrompt() || " ",
    appendSystemPromptOverride: () => [],
    /**
     * THE DEFINITION'S SKILLS, PLUS THE MACHINE'S — an agent inherits the box it runs on (machine.ts), and the
     * definition wins a name collision.
     *
     * NO DISCOVERY OF ITS OWN: the machine's half is the process's single read, so a bound session and `commands()`
     * describe the same box. A loader discovering for itself is what made the menu live while a session was not.
     */
    noSkills: true,
    skillsOverride: () => ({
      skills: withMachine(toPiSkills(source.skills()) as MachineSkill[], source.machine.skills),
      diagnostics: [],
    }),
    noPromptTemplates: true,
    promptsOverride: () => ({ prompts: [...source.machine.prompts], diagnostics: [] }),
  };
}

/** Manual compactions waiting for pi's admission, keyed by the session's record (what an extension's `ctx` names). */
const compactAdmissions = new WeakMap<SessionManager, () => void>();

const COMPACT_ADMISSION = "fastagent-compact-admission";

/**
 * pi's own admission signal for a manual compaction: `session_before_compact` fires only once `prepareCompaction`
 * found work, and before the model call. It must be the FIRST listener ({@link admissionFirst}): pi awaits each
 * handler in turn, and a definition's own handler (a custom summarizer, a cancel) runs after admission, like the
 * model call it may replace.
 */
const compactAdmission: InlineExtension = {
  name: COMPACT_ADMISSION,
  hidden: true,
  factory: (pi) => {
    pi.on("session_before_compact", (event, ctx) => {
      if (event.reason === "manual") admitCompaction(ctx.sessionManager as SessionManager);
    });
  },
};

/**
 * pi loads path extensions first and appends inline factories after them, so {@link compactAdmission} arrives last.
 * Moved to the front here, since pi dispatches handlers in extension order.
 */
function admissionFirst(base: LoadExtensionsResult): LoadExtensionsResult {
  const path = `<inline:${COMPACT_ADMISSION}>`;
  const admission = base.extensions.filter((extension) => extension.path === path);
  return { ...base, extensions: [...admission, ...base.extensions.filter((extension) => extension.path !== path)] };
}

/** Tell a waiting {@link startCompaction} that pi admitted the compaction on this record. */
export function admitCompaction(record: SessionManager): void {
  compactAdmissions.get(record)?.();
}

/**
 * pi's refusals when `prepareCompaction` finds nothing. They are plain Errors, so their text is the only way to tell
 * them from pi's other failures before admission (no model, credentials that do not resolve). If pi rewords them,
 * the refusal still fails visibly, as `boundary_command_failed` instead of `nothing_to_compact`, and the admission
 * tests in session-control.test.ts, which run pi's real refusal, fail with it.
 */
const NOTHING_TO_COMPACT = /^(Nothing to compact|Already compacted)\b/;

/** What pi decided before its model call: go ahead, nothing to do, or a failure of its own (in `refused`). */
export type CompactAdmission = "admitted" | "nothing_to_compact" | { refused: unknown };

/**
 * Start pi's manual compaction on a bound session. `onAdmitted` runs INSIDE pi's admission event, so everything it
 * publishes precedes anything pi does next (the model call, its retries). `admission` settles before the model call.
 * pi's own pre-admission failures come back as `refused` rather than a rejection: the caller answers them to its
 * Caller as a result. `done` is the compaction itself.
 */
export function startCompaction(
  session: AgentSession,
  instructions: string | undefined,
  onAdmitted: () => void,
): { admission: Promise<CompactAdmission>; done: Promise<CompactionResult> } {
  const record = session.sessionManager;
  const admitted = new Promise<"admitted">((resolve) => {
    compactAdmissions.set(record, () => {
      try {
        onAdmitted();
      } finally {
        resolve("admitted");
      }
    });
  });
  const done = session.compact(instructions);
  const forget = () => void compactAdmissions.delete(record);
  done.then(forget, forget);
  const settledFirst = done.then(
    () => {
      throw new Error("pi finished a compaction without announcing its admission (session_before_compact)");
    },
    (error: unknown): CompactAdmission =>
      error instanceof Error && NOTHING_TO_COMPACT.test(error.message) ? "nothing_to_compact" : { refused: error },
  );
  return { admission: Promise.race([admitted, settledFirst]), done };
}

/**
 * The resources ONE served session runs on: a fresh loader, so fresh extension instances.
 *
 * Assembled here rather than by pi's `createAgentSessionServices`, which ends by refreshing the model runtime it is
 * given — re-reading `models.json` and rebuilding every provider on the ONE runtime all conversations share. That is
 * there to fold in providers extensions registered, which serving refuses; per session it would be a full provider
 * rebuild per turn.
 */
async function servingServices(options: {
  cwd: string;
  modelRuntime: ModelRuntime;
  definition: PiSessionDefinition;
  extensionPaths: readonly string[];
}): Promise<AgentSessionServices> {
  const { cwd, modelRuntime, definition, extensionPaths } = options;
  const machine = await readMachine(cwd);
  const agentDir = getAgentDir();
  // The machine's engine settings, as read at boot and without `packages` — a turn never resolves one.
  const settingsManager = machine.settingsManager();
  const resourceLoader = new DefaultResourceLoader({
    ...definitionResourceLoaderOptions({
      systemPrompt: () => definition.systemPrompt,
      skills: () => definition.skills,
      machine,
      extensionPaths,
    }),
    extensionsOverride: (base) => admissionFirst(refuseLoadTimeProviders(base)),
    extensionFactories: [compactAdmission],
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();
  const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  reportExtensionErrors(services);
  return services;
}

/**
 * The `/name` commands a served session dispatches, named the way pi resolves them (a name two extensions share gets
 * a `:N` suffix). Loaded through the same {@link servingServices} a turn binds, so the menu and the dispatch cannot
 * disagree. Loading runs the extensions' factories; no session opens, so `session_start` does not fire, and the
 * instances are never bound (any action they call throws).
 */
export async function servedExtensionCommands(options: {
  cwd: string;
  modelRuntime: ModelRuntime;
  extensionPaths: readonly string[];
}): Promise<ResolvedCommand[]> {
  if (options.extensionPaths.length === 0) return [];
  const services = await servingServices({ ...options, definition: { skills: [] } });
  const { extensions, runtime } = services.resourceLoader.getExtensions();
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    options.cwd,
    SessionManager.inMemory(options.cwd),
    new ModelRegistry(options.modelRuntime),
  );
  return runner.getRegisteredCommands();
}

/**
 * Open-or-create the record, then bind a fresh session to it — on a fresh resource loader.
 *
 * ONE LOADER PER SESSION, because pi's extension runtime belongs to its loader: a loader shared across concurrent
 * turns would let one conversation's extension act on another's session. It also makes the definition live with no
 * bookkeeping: every bind reads the prompt and skills this invoke read. The machine's half is the process's one read
 * (machine.ts). Extension CODE is imported once per process, so an edit to `extensions/` needs a restart, which is
 * what `dev` does on one.
 */
export function piAgentSessionFactory(options: PiAgentSessionFactoryOptions): PiAgentSessionFactory {
  const { sessions, thinkingLevel, cwd } = options;
  const extensionPaths = options.extensionPaths ?? [];
  const excludedToolNames = options.excludedToolNames ?? [];
  const tools = options.tools ?? [];
  // `ctx.ui.theme` reads pi's global theme, which only pi's own entry points initialize.
  if (extensionPaths.length > 0) initTheme();
  let engine: Promise<{ modelRuntime: ModelRuntime; model: AnyModel }> | undefined;

  return async (sessionId, inherit) => {
    const definition = await options.readDefinition();
    engine ??= options.engine();
    const { modelRuntime, model } = await engine;
    // The record first: a control write that races this turn must find the session and be refused busy.
    const sessionManager: SessionManager = await sessions.openOrCreate(sessionId, inherit);
    const services = await servingServices({ cwd, modelRuntime, definition, extensionPaths });
    // What the session RUNS on: the boundary plane records model/thinking overrides as entries, and pi does not read
    // them back.
    const settings = resolveSessionSettings(activePath(sessionManager), modelRuntime, {
      model,
      thinkingLevel: thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    });
    const { session } = await bindPiSession({
      services,
      sessionManager,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      tools,
      cwd,
      excludedToolNames,
      sessionId,
      recordActivations: true,
    });
    refuseLateProviders(services);
    // `onError` is THE ONLY LISTENER for a fault pi reports nowhere else: `/skill:<name>` is expanded by reading
    // `filePath` at prompt time, and when that read fails pi raises `skill_expansion` on the extension error channel
    // and sends the line to the model unexpanded. The list can outlive the file: it is refreshed per invoke, so a
    // steer or follow-up inside a run, or a definition replaced under a running container (`src/deploy/workspace.ts`),
    // reaches exactly that state. The same channel carries every extension handler's failure.
    //
    // No `uiContext`: a served turn has no human at a terminal, and pi's default is what extensions are written to
    // detect (`ctx.hasUI === false`; dialogs resolve as cancelled). This call fires `session_start`.
    await session.bindExtensions({
      onError: ({ extensionPath, event, error }) =>
        log.warn(`[fastagent] session ${sessionId}: ${event} failed for ${extensionPath}: ${error}`),
      commandContextActions: servingCommandActions(session),
      shutdownHandler: () =>
        log.warn(
          `[fastagent] session ${sessionId}: an extension called ctx.shutdown(); a served process is stopped by its host, not by a turn`,
        ),
    });
    return session;
  };
}

/** fastagent's Skill (content inline) as pi's (read from filePath at invocation time). */
function toPiSkills(skills: Skill[]) {
  return skills.map((skill) => {
    const baseDir = dirname(skill.filePath);
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir,
      sourceInfo: {
        path: skill.filePath,
        source: "fastagent",
        scope: "project",
        origin: "top-level",
        baseDir,
      },
      disableModelInvocation: skill.disableModelInvocation ?? false,
    };
  });
}
