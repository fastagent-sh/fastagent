/**
 * The AgentSession L0's engine binding: fastagent's assembled agent — model, prompt, skills, tools — bound to one
 * durable record, per invoke.
 */
import { dirname } from "node:path";
import {
  BUILTIN_EXTENSIONS,
  DISCOVERY,
  type Machine,
  type MachinePrompt,
  type MachineSkill,
  readMachine,
  withMachine,
} from "./machine.ts";
import type { Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionServices,
  type CompactionResult,
  type CreateAgentSessionServicesOptions,
  type ExtensionCommandContextActions,
  type ExtensionFactory,
  type InlineExtension,
  ExtensionRunner,
  type LoadExtensionsResult,
  ModelRegistry,
  type ModelRuntime,
  type ResolvedCommand,
  SessionManager,
  type ToolDefinition,
  createAgentSessionServices,
  createCodemodeExtension,
  createToolSearchExtension,
  createAgentSessionFromServices,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import { log } from "../../log.ts";
import type { ResolvedContext } from "../../contexts/resolve.ts";
import type { PiSessionRecordStore } from "./session-store.ts";
import type { MountedTool } from "./tool.ts";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { resolveModel } from "./config.ts";
import { MissingModel, activePath, resolveSessionSettings } from "./session-settings.ts";
import { type AnyModel, DEFAULT_THINKING_LEVEL, withModelRegistration } from "./models.ts";
import { registerAccountModels } from "./openai-account-models.ts";
import { abortedAnswer, asksToEndRun, markEndsRun } from "./turn-kit.ts";
import { type TurnContext, agentSessionManager, sessionToolActivation, turnContext } from "./tool-context.ts";
import type { DefinitionPrompt } from "./definition.ts";

/** What one binding reads from the definition: the prompt pieces, skills and prompt templates pi is handed. */
export interface PiSessionDefinition {
  /** Replaces pi's default prompt when set (`SYSTEM.md`, L2's `base`, L1's `instructions`); absent → pi's default. */
  systemPrompt?: string;
  /** Added after the prompt, whichever it is (`APPEND_SYSTEM.md`). */
  appendSystemPrompt?: string;
  /** Project instructions (AGENTS.md); pi renders them as its project context. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** FastAgent's own named prompt sections: pi renders them after its own, whoever wrote the rest. */
  sections?: Record<string, string>;
  skills: Skill[];
  /** The definition's own prompt templates; the machine's are added behind them. */
  prompts?: DefinitionPrompt[];
}

export interface PiAgentSessionFactoryOptions {
  /** Where conversations live. */
  sessions: PiSessionRecordStore;
  /** A fresh model runtime per binding: extension routers and provider registrations belong to this session. */
  engine: () => Promise<{ modelRuntime: ModelRuntime }>;
  /**
   * The default model, resolved after extensions register their models. Optional: a session that records a model
   * runs on it, and one that records none is refused with {@link MissingModel} when there is no default either.
   */
  modelSpec?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: MountedTool[];
  /** Read once per binding; prompt and skills come from the same definition read. */
  readDefinition: () => PiSessionDefinition | Promise<PiSessionDefinition>;
  /** The agent's working directory — what fastagent-defined tools see as `cwd`. */
  cwd: string;
  /** What fastagent-defined tools see as `contexts`. */
  contexts?: readonly ResolvedContext[];
  /** The definition's own extension entry points, asked for every bound session (and current when it answers). */
  extensionPaths?: () => Promise<readonly string[]>;
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
}

type ToolBinding = { session: AgentSession; context: TurnContext };

/**
 * What pi's own coding tools say about themselves in its default prompt. The coding tools fastagent mounts are pi's
 * `AgentTool`s, which carry neither field, and they replace pi's definitions of the same name, so without this pi's
 * tool list would lose them and its rules would lose their guidelines.
 */
const PI_TOOL_PROMPTS: ReadonlyMap<string, Pick<ToolDefinition, "promptSnippet" | "promptGuidelines">> = new Map(
  [
    createReadToolDefinition,
    createBashToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ].map((create) => {
    const definition = create(".");
    return [
      definition.name,
      { promptSnippet: definition.promptSnippet, promptGuidelines: definition.promptGuidelines },
    ];
  }),
);

/**
 * The line pi's default prompt lists a tool by. pi lists only tools that have one; an authored tool's is the first
 * line of its description, so `defineTool` needs no field of its own.
 */
function promptFields(tool: MountedTool): Pick<ToolDefinition, "promptSnippet" | "promptGuidelines"> {
  const own = tool as Pick<ToolDefinition, "promptSnippet" | "promptGuidelines">;
  const pi = PI_TOOL_PROMPTS.get(tool.name);
  const promptSnippet = own.promptSnippet ?? pi?.promptSnippet ?? tool.description?.split("\n")[0]?.trim();
  const promptGuidelines = own.promptGuidelines ?? pi?.promptGuidelines;
  return {
    ...(promptSnippet ? { promptSnippet } : {}),
    ...(promptGuidelines ? { promptGuidelines } : {}),
  };
}

/** fastagent's tools as pi tool definitions, bound to ONE session. */
function toolDefinitions(tools: MountedTool[], bound: { current?: ToolBinding }, sessionId: string): ToolDefinition[] {
  return tools.map(
    (tool): ToolDefinition => ({
      ...tool,
      ...promptFields(tool),
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
  /** What fastagent-defined tools see as `contexts`. */
  contexts?: readonly ResolvedContext[];
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
  /** The CALLER's session id — what a tool asking which conversation it is in hears. */
  sessionId?: string;
}

/** The {@link DISCOVERY} tools the mounted tools' exposures need. A disabled extension's name is ignored by Pi. */
function discoveryToolNames(tools: readonly MountedTool[]): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.exposure === "codemode" || tool.exposure === "deferred") names.add(DISCOVERY[tool.exposure].tool);
  }
  return [...names];
}

/**
 * Bind ONE pi session to a record: authored tools replace same-name built-ins; Pi owns exposure and discovery.
 */
export async function bindPiSession(options: BindPiSessionOptions): ReturnType<typeof createAgentSessionFromServices> {
  const { services, sessionManager, model, thinkingLevel, tools, cwd } = options;
  const excludedToolNames = options.excludedToolNames ?? [];
  const history = sessionManager.buildSessionContext().messages;
  const bound: { current?: ToolBinding } = {};
  const sessionId = options.sessionId ?? sessionManager.getSessionId();
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
    model,
    thinkingLevel,
    ...(excludedToolNames.length > 0 ? { excludeTools: [...excludedToolNames] } : {}),
    customTools: toolDefinitions(tools, bound, sessionId),
  });
  const { session } = result;
  // One context for the whole session: it describes the SESSION, not the call.
  bound.current = {
    session,
    context: {
      cwd,
      contexts: options.contexts ?? [],
      sessionManager: agentSessionManager(session, sessionId),
      tools: sessionToolActivation(session),
    },
  };
  // The SDK always supplies an initial loadout (settings' defaultTools applied), bypassing AgentSession's native
  // transcript restore. The loadout is the definition's defaults as they are NOW, plus whatever the transcript still
  // declares and is still mounted (a discovery). Removals in the transcript are not honored: fastagent's own activation
  // only adds, so a removal records a turn on which the definition did not mount the tool, not the conversation's
  // choice, and honoring it would keep a tool out of a long-lived chat after a release that briefly lacked it.
  // Replayed through Pi's public APIs, for serving and chat alike.
  const defaults = [...session.getActiveToolNames(), ...discoveryToolNames(tools)];
  const current = getCurrentSystemMessage(history);
  const mounted = new Set(session.getAllTools().map((tool) => tool.name));
  const declared = (current?.toolsAdded ?? []).map((tool) => tool.name);
  const dropped = declared.filter((name) => !mounted.has(name));
  // Debug, not warn: `session_start` handlers register their tools after this point, and Pi activates the
  // default-active ones when they do (`_refreshToolRegistry`), so an absence here is routine on every such bind.
  if (dropped.length) log.debug(`[fastagent] session ${sessionId}: not mounted yet or removed: ${dropped.join(", ")}`);
  session.setActiveToolsByName([...defaults, ...declared.filter((name) => mounted.has(name))]);
  return result;
}

let themeReady = false;

/** Each distinct load diagnostic is said once per process: serving loads the extensions again for every session. */
const reportedExtensionDiagnostics = new Set<string>();

/**
 * Extension notifications said once per process at their own level, then at debug: every served turn starts the
 * extensions again, so a notification from `session_start` would otherwise log the same line on every message.
 */
const reportedNotifications = new Set<string>();
// ponytail: cleared wholesale at this size, so a notification with a counter or id in it cannot grow the set for the
// life of a `start` process; the price is one repeat at warn level after each clear. An LRU if that ever matters.
const MAX_REPORTED_NOTIFICATIONS = 1000;

/**
 * Announce extensions pi failed to load, and what it warned about while loading the rest: among them a definition
 * extension that registers `codemode` or `tool_search`, which keeps pi's built-in of that name from loading. pi
 * collects both into `LoadExtensionsResult` and carries on; only its own TUI shows them.
 */
function reportExtensionDiagnostics(services: AgentSessionServices): void {
  for (const diagnostic of services.diagnostics) {
    if (diagnostic.type === "error") throw new Error(diagnostic.message);
  }
  const { errors, warnings = [] } = services.resourceLoader.getExtensions();
  const said = [
    ...errors.map(({ path, error }) => `extension ${path} failed to load: ${error}`),
    ...warnings.map(({ path, warning }) => `extension ${path}: ${warning}`),
  ];
  for (const line of said) {
    if (reportedExtensionDiagnostics.has(line)) continue;
    reportedExtensionDiagnostics.add(line);
    log.warn(`[fastagent] ${line}`);
  }
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

const nativeFactories: Record<(typeof BUILTIN_EXTENSIONS)[number], ExtensionFactory> = {
  codemode: createCodemodeExtension(),
  "tool-search": createToolSearchExtension(),
};
const nativeExtensions: InlineExtension[] = BUILTIN_EXTENSIONS.map((name) => ({
  name,
  factory: nativeFactories[name],
  replaceable: true,
  builtin: true,
}));

/**
 * FastAgent's own prompt sections, added on `before_agent_start`: pi renders custom sections after its own, so they
 * survive a `SYSTEM.md` that replaced pi's default, and they stay out of the slot `APPEND_SYSTEM.md` fills.
 */
function fastagentSections(sections: Record<string, string>): InlineExtension {
  return {
    name: "fastagent-sections",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        Object.assign(event.systemPromptOptions.sections, sections);
      });
    },
  };
}

/** The resource posture a fastagent definition asks pi for — ONE definition of it, for both assemblies. */
export function definitionResourceLoaderOptions(source: {
  definition: PiSessionDefinition;
  /** {@link readMachine} for this agent directory — resolved by the caller, because this function is synchronous. */
  machine: Machine;
  extensionPaths?: readonly string[];
}): DefinitionLoaderOptions {
  const { definition } = source;
  return {
    extensionFactories: [
      ...nativeExtensions,
      compactAdmission,
      recordEndsRun,
      recordAbortedAnswers,
      ...(definition.sections && Object.keys(definition.sections).length > 0
        ? [fastagentSections(definition.sections)]
        : []),
    ],
    // The machine's extensions are its owner's setup, not this agent's.
    noExtensions: true,
    // Explicit paths survive noExtensions, including Pi's built-ins; so they would also survive the machine's own
    // `-builtin:<name>`, which is why only the enabled ones are named. Machine extensions stay out.
    additionalExtensionPaths: [
      ...source.machine.builtinExtensions.map((name) => `builtin:${name}`),
      ...(source.extensionPaths ?? []),
    ],
    // Not pi's discovery: the definition read them (definition.ts), and pi renders what it is handed.
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: definition.contextFiles ?? [] }),
    // The IDENTITY is the definition's, whatever the machine thinks: pi's `base` here is the machine's SYSTEM.md, and
    // it is never used. Inheriting skills is inheriting capability; inheriting a system prompt would be the agent
    // becoming someone else's agent. Undefined leaves pi to build its default.
    systemPromptOverride: () => definition.systemPrompt,
    appendSystemPromptOverride: () => (definition.appendSystemPrompt ? [definition.appendSystemPrompt] : []),
    /**
     * THE DEFINITION'S SKILLS, PLUS THE MACHINE'S — an agent inherits the box it runs on (machine.ts), and the
     * definition wins a name collision.
     *
     * NO DISCOVERY OF ITS OWN: the machine's half is the process's single read, so a bound session and `commands()`
     * describe the same box. A loader discovering for itself is what made the menu live while a session was not.
     */
    noSkills: true,
    skillsOverride: () => ({
      skills: withMachine(toPiSkills(definition.skills) as MachineSkill[], source.machine.skills),
      diagnostics: [],
    }),
    noPromptTemplates: true,
    promptsOverride: () => ({
      prompts: withMachine(toPiPrompts(definition.prompts ?? []) as MachinePrompt[], source.machine.prompts),
      diagnostics: [],
    }),
  };
}

/**
 * Records on a tool result that it asked to end its run ({@link asksToEndRun}), so `entries()` can tell a run that
 * ended on its tool batch from one cut after its tools. Through pi's `message_end` replacement, which runs before pi
 * appends the message to the record. LAST among the extensions (pi appends inline factories after path ones), so a
 * definition's own `message_end` replacement cannot drop the flag. One instance per loader, so per session.
 */
const recordEndsRun: InlineExtension = {
  name: "fastagent-record-ends-run",
  hidden: true,
  factory: (pi) => {
    const asked = new Set<string>();
    pi.on("tool_execution_end", (event) => {
      if (asksToEndRun(event)) asked.add(event.toolCallId);
    });
    pi.on("message_end", (event) => {
      const message = event.message;
      if (message.role !== "toolResult" || !asked.delete(message.toolCallId)) return;
      return { message: markEndsRun(message) };
    });
  },
};

/**
 * Records an answer that failed because its run was stopped as aborted ({@link abortedAnswer}), through pi's
 * `message_end` replacement, which runs before pi appends the message to the record and before the plane's own
 * listener sees it. `ctx.signal` is the run's own abort signal, the one pi's readings use.
 */
const recordAbortedAnswers: InlineExtension = {
  name: "fastagent-record-aborted-answers",
  hidden: true,
  factory: (pi) => {
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const aborted = abortedAnswer(event.message, ctx.signal);
      return aborted ? { message: aborted } : undefined;
    });
  },
};

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
 * them from any other error pi raises before admission. If pi rewords them, the refusal still fails visibly, as
 * `boundary_command_failed` instead of `nothing_to_compact`, and the admission tests in session-control.test.ts,
 * which run pi's real refusal, fail with it.
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

/** A fresh loader and Pi's native model registration, over a session-local runtime. */
export async function definitionServices(options: {
  cwd: string;
  modelRuntime: ModelRuntime;
  definition: PiSessionDefinition;
  extensionPaths: readonly string[];
}): Promise<AgentSessionServices> {
  const { cwd, modelRuntime, definition, extensionPaths } = options;
  const machine = await readMachine(cwd);
  const services = await withModelRegistration(modelRuntime, () =>
    createAgentSessionServices({
      cwd,
      agentDir: getAgentDir(),
      modelRuntime,
      settingsManager: machine.settingsManager(),
      resourceLoaderOptions: {
        ...definitionResourceLoaderOptions({
          definition,
          machine,
          extensionPaths,
        }),
        extensionsOverride: admissionFirst,
      },
    }).then((services) => {
      // AFTER the extensions: one that re-registers `openai` replaced the account-catalog wrapper.
      registerAccountModels(modelRuntime);
      return services;
    }),
  );
  reportExtensionDiagnostics(services);
  return services;
}

/**
 * The `/name` commands a served session dispatches, named the way pi resolves them (a name two extensions share gets
 * a `:N` suffix). Loaded through the same {@link definitionServices} a turn binds, so the menu and the dispatch cannot
 * disagree. Loading runs the extensions' factories; no session opens, so `session_start` does not fire, and the
 * instances are never bound (any action they call throws).
 */
export async function servedExtensionCommands(options: {
  cwd: string;
  modelRuntime: ModelRuntime;
  extensionPaths: readonly string[];
}): Promise<ResolvedCommand[]> {
  const services = await definitionServices({ ...options, definition: { skills: [] } });
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
 * (machine.ts). Extensions are live too: `extensionPaths` is asked for every bind, and answers only once pi's cache
 * holds the code on disk (live-extensions.ts), so the session loads the code as it is now.
 */
export function piAgentSessionFactory(options: PiAgentSessionFactoryOptions): PiAgentSessionFactory {
  const { sessions, thinkingLevel, cwd } = options;
  const excludedToolNames = options.excludedToolNames ?? [];
  const tools = options.tools ?? [];

  return async (sessionId, inherit) => {
    // `ctx.ui.theme` reads pi's global theme, which only pi's own entry points initialize. Serving only: chat's theme
    // is InteractiveMode's, and resetting it on every session switch would drop the user's.
    if (!themeReady) {
      initTheme();
      themeReady = true;
    }
    // Without a default, a turn that cannot run must leave no conversation behind in the listing. A new record with
    // nothing to inherit records no model, so it is refused before it is created. One that inherits may get a model
    // from its parent, which only the copy decides (the store's cut), so it is created and, if still model-less,
    // removed below. The caller holds this session's lease, so nothing else creates the record in between.
    const existed = options.modelSpec ? true : (await sessions.openIfExists(sessionId)) !== undefined;
    if (!existed && !inherit) throw new MissingModel(sessionId, []);
    // Publish the record before loading resources: boundary writes must find it while binding is in flight.
    const sessionManager: SessionManager = await sessions.openOrCreate(sessionId, inherit);
    const definition = await options.readDefinition();
    const { modelRuntime } = await options.engine();
    const extensionPaths = (await options.extensionPaths?.()) ?? [];
    const services = await definitionServices({ cwd, modelRuntime, definition, extensionPaths });
    const model = options.modelSpec ? resolveModel(modelRuntime, options.modelSpec) : undefined;
    // What the session RUNS on: the boundary plane records model/thinking overrides as entries, and pi does not read
    // them back.
    const path = activePath(sessionManager);
    const settings = resolveSessionSettings(path, modelRuntime, {
      ...(model ? { model } : {}),
      thinkingLevel: thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    });
    if (!settings) {
      const missing = new MissingModel(sessionId, path);
      if (!existed) {
        // The record this bind created for a thread whose parent supplied no model. A failed removal is reported on
        // its own and does not replace `missing`: the caller still needs the missing_model answer and its fix.
        await sessions.delete(sessionId).catch((error: unknown) => {
          log.warn(`[fastagent] session ${sessionId}: could not remove the record of a refused turn: ${String(error)}`);
        });
      }
      throw missing;
    }
    const { session } = await bindPiSession({
      services,
      sessionManager,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      tools,
      cwd,
      contexts: options.contexts ?? [],
      excludedToolNames,
      sessionId,
    });
    // Pi's headless UI drops notifications. Keep dialogs cancelled and hasUI false, but surface diagnostics.
    const runner = session.extensionRunner;
    if (runner) {
      const createContext = runner.createContext.bind(runner);
      runner.createContext = () => {
        const context = createContext();
        // Pi clones own descriptors for before_agent_start; inherited fields would disappear there.
        return Object.defineProperty(context, "ui", {
          value: {
            ...context.ui,
            notify: (message: string, type?: "info" | "warning" | "error") => {
              const key = `${type ?? "info"}\u0000${message}`;
              const repeat = reportedNotifications.has(key);
              if (reportedNotifications.size >= MAX_REPORTED_NOTIFICATIONS) reportedNotifications.clear();
              reportedNotifications.add(key);
              const emit = repeat ? log.debug : type === "info" ? log.info : log.warn;
              emit(`[fastagent] session ${sessionId}: ${message}`);
            },
          },
        });
      };
    }
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

/** The definition's prompt templates as pi's. */
function toPiPrompts(prompts: DefinitionPrompt[]) {
  return prompts.map((prompt) => {
    const baseDir = dirname(prompt.filePath);
    return {
      name: prompt.name,
      description: prompt.description ?? "",
      content: prompt.content,
      filePath: prompt.filePath,
      sourceInfo: { path: prompt.filePath, source: "fastagent", scope: "project", origin: "top-level", baseDir },
    };
  });
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
