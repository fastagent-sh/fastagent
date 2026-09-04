/**
 * The AgentSession L0's engine binding: fastagent's assembled agent — model, prompt, skills, tools —
 * bound to one durable record, per invoke.
 *
 * The chat path builds the same pi class from the same assembly (session-builder.ts) but keeps ONE
 * resident session. What is specific here is the posture: many sessions, one turn each, nothing in
 * memory between turns.
 *
 * Shared once, rebuilt per turn:
 * - `services` (ResourceLoader, settings, model runtime) is built lazily and reused — it is the
 *   expensive half, and it holds nothing session-specific;
 * - the `AgentSession` and its tool bindings are per turn, because a tool's `execute` closes over the
 *   session it runs in and this posture has several in flight at once.
 */
import { dirname, join } from "node:path";
import type { ExecutionEnv, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type ModelRuntime,
  type SessionManager,
  type ToolDefinition,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { PiAgentSessionFactory } from "./invoke-session.ts";
import { log } from "../../log.ts";
import type { PiSessionRecordStore } from "./session-store.ts";
import { isDeferredTool, type MountedTool } from "./tool.ts";
import { activePath, resolveSessionSettings } from "./session-settings.ts";
import { DEFAULT_THINKING_LEVEL } from "./models.ts";
import { type TurnContext, agentSessionManager, sessionToolActivation, turnContext } from "./tool-context.ts";

/** pi's Model with the API-shape generic erased; fastagent only passes models through. */
// biome-ignore lint/suspicious/noExplicitAny: variance-friendly model type, audited at this single point
type AnyModel = Model<any>;

export interface PiAgentSessionFactoryOptions {
  /** Where conversations live. Continuity = same store + same session id. */
  sessions: PiSessionRecordStore;
  /**
   * The model to run and the hub that authenticates it, resolved on FIRST USE and kept.
   *
   * A thunk because building a `ModelRuntime` is async while assembling an agent is not: the L1
   * surface hands back an `Agent` synchronously, so the credential read that a runtime performs
   * belongs on the first turn rather than in the caller's constructor. The two travel together
   * because a model must be resolved against the runtime that holds its provider's auth.
   */
  engine: () => Promise<{ modelRuntime: ModelRuntime; model: AnyModel }>;
  thinkingLevel?: ThinkingLevel;
  tools?: MountedTool[];
  /** Final assembled prompt, or a factory re-evaluated per turn. */
  systemPrompt?: string | (() => string);
  skills?: Skill[];
  /** Per-turn source for the prompt+skills PAIR; supersedes the two above. This is what keeps
   *  "the directory is the agent, LIVE" true on a shared `services`: the ResourceLoader is built
   *  once, but what it serves is re-read here. */
  live?: () => Promise<{ systemPrompt?: string; skills?: Skill[] }>;
  /** The agent's working directory — what fastagent-defined tools see as `cwd`. */
  cwd: string;
  /**
   * Where pi looks for ITS settings (retry budget, compaction thresholds, default thinking level).
   *
   * Deliberately NOT pi's machine-global `~/.pi/agent`: a served agent must behave the same on the
   * author's laptop and in a container, and reading the operator's personal pi configuration is the
   * artifact losing to the machine. Point it at a definition-scoped path; a missing directory simply
   * means pi's own defaults, which is the intended baseline.
   */
  agentDir?: string;
  /**
   * The definition's own extension entry points, for ANNOUNCING that serving does not run them.
   *
   * pi's extension machinery is built for one process serving one session: `bindCore()` copies the
   * session's actions into a runtime the pi source itself calls "the shared runtime", extension
   * modules are cached per assembly, and `session_start`/`session_shutdown` are a matched pair.
   * Serving breaks every one of those assumptions — concurrent turns for unrelated conversations —
   * and the failure is silent cross-talk: with two turns in flight, an extension calling
   * `pi.sendMessage()` can deliver into the other conversation.
   *
   * Loading them anyway would be a correctness bug dressed as a feature, so serving does not, and
   * warns when a definition ships some. `chat` runs them fully: one session, one runtime, which is
   * exactly the shape pi is built for.
   *
   * Isolating them per session is mechanically possible — pi's uncached loader path builds a fresh
   * module (jiti with `moduleCache: false`) and takes the runtime as an argument — but that function
   * is not exported and the deep path is blocked by the package's `exports`. Reopening this needs
   * that entry point upstream, not a workaround here.
   */
  extensionPaths?: string[];
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
  /** Filesystem/process environment: definition loading, and the turn context for tools that read one. */
  env: ExecutionEnv;
}

/**
 * The session custom-entry type recording ONE activation delta: `{ names }` — exactly the deferred
 * tools a loader activated in that call.
 *
 * A DEDICATED record, not pi's own `active_tools_change`: that one is a full SNAPSHOT of everything
 * active at the moment, so replaying it would keep a tool active in old sessions after the author
 * flips it to `deferred` — the session never discovered it. A delta carries only what was actually
 * found, and is layered onto whatever the workspace mounts TODAY.
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

/** Warned once per session+missing set: a fresh session is built per invoke and channel sessions run
 *  for weeks, so an un-deduped warn would repeat every turn and dilute its own signal. */
const warnedDroppedActivations = new Set<string>();

/**
 * fastagent's tools as pi tool definitions, bound to ONE session.
 *
 * `bound` is filled after the session exists — pi needs the definitions to build the session, and a
 * tool needs the session to reach the turn context. A tool that somehow runs before that binding
 * throws rather than executing outside the turn: a broken lifecycle must not look like a normal
 * out-of-turn call.
 *
 * It carries the whole turn CONTEXT, not just the session: the activation bridge holds the lock that
 * orders concurrent activations, so it has to live as long as the session the activations mutate.
 * Building it here, per call, would hand each parallel tool its own.
 */
function toolDefinitions(tools: MountedTool[], env: ExecutionEnv, bound: { context?: TurnContext }): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    // An activating tool (the built-in loader) declares "sequential" so pi serializes its batch;
    // without it pi's outer active-set diff double-stamps parallel calls.
    executionMode: tool.executionMode,
    execute: (id: string, params: unknown, signal: AbortSignal | undefined) => {
      const context = bound.context;
      if (!context) throw new Error("tool executed before its turn context was bound (lifecycle invariant broken)");
      return turnContext.run(
        context,
        // Lower-level MountedTools may consume the fifth-argument env. Directory coding tools are
        // cwd-bound and ignore it; authored tools read FastAgent's turnContext instead.
        () => tool.execute(id, params, signal, undefined, { env }) as Promise<unknown>,
      );
    },
  })) as unknown as ToolDefinition[];
}

export interface BindPiSessionOptions {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  /** Chat only: pi's runtime hands the resumed/new session its start event. */
  sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];
  model: AnyModel;
  thinkingLevel: ThinkingLevel | undefined;
  tools: MountedTool[];
  env: ExecutionEnv;
  /** The agent's working directory — what fastagent-defined tools see as `cwd`. */
  cwd: string;
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
  /** The CALLER's session id — what a tool asking which conversation it is in hears. Defaults to
   *  pi's own id, which is right where the caller has none (chat). */
  sessionId?: string;
  /** Record each discovered activation on the session, so the next bind restores it. Off for chat:
   *  pi's own session has nowhere to put one, so a resumed chat re-discovers. */
  recordActivations: boolean;
}

/**
 * Bind ONE pi session to a record: the definition's tools as pi definitions over one turn context,
 * pi's own tool copies kept off, and deferral applied. The per-invoke factory and the resident chat
 * runtime both bind here — they differ in what they hand in (a shared vs a per-session `services`,
 * record-resolved vs configured settings) and in whether a discovered activation has a record to
 * land in, and in nothing else. Two copies of this drifted once (the tool adapter and the deferral
 * narrowing each existed twice, identical but for those parameters).
 */
export async function bindPiSession(
  options: BindPiSessionOptions,
): Promise<Awaited<ReturnType<typeof createAgentSessionFromServices>> & { context: TurnContext }> {
  const { services, sessionManager, model, thinkingLevel, tools, env, cwd, recordActivations } = options;
  const excludedToolNames = options.excludedToolNames ?? [];
  const deferred = tools.filter(isDeferredTool).map((t) => t.name);
  const bound: { context?: TurnContext } = {};
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    ...(options.sessionStartEvent ? { sessionStartEvent: options.sessionStartEvent } : {}),
    model,
    thinkingLevel,
    // pi would otherwise mount its built-ins on top of fastagent's copies, offering duplicate names.
    // Lower-level callers with an explicit list also rely on omitted built-ins staying omitted. And
    // NO `tools` allowlist: it would freeze the set at bind time, while pi lets an extension register
    // from `session_start` — `noTools: "builtin"` gives the guarantee the allowlist was there for.
    noTools: "builtin",
    ...(excludedToolNames.length > 0 ? { excludeTools: [...excludedToolNames] } : {}),
    customTools: toolDefinitions(tools, env, bound),
  });
  const { session } = result;
  const sessionId = options.sessionId ?? session.sessionManager.getSessionId();
  // One context for the whole session: it describes the SESSION, not the call. The activation
  // bridge above all — a tool call has to see what the previous one activated.
  const context: TurnContext = {
    cwd,
    sessionManager: agentSessionManager(session, sessionId),
    // A served session HAS somewhere to record the discovery, so it does: the delta is what makes
    // the tool still callable next turn (see {@link TOOL_ACTIVATION_ENTRY}).
    tools: sessionToolActivation(
      session,
      recordActivations
        ? (added) => session.sessionManager.appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: added })
        : undefined,
    ),
  };
  bound.context = context;
  // Deferral, then restoration: pi starts every mounted tool active, so narrow by SUBTRACTING the
  // deferred names (robust to pi mounting tools of its own, unlike an exact-set replacement), then
  // add back what THIS session has already discovered.
  if (deferred.length > 0) {
    const active = session.getActiveToolNames();
    const mounted = new Set(session.getAllTools().map((tool) => tool.name));
    const recorded = recordActivations ? recordedActivations(session) : [];
    // A recorded name that is no longer mounted is dropped rather than replayed: pi's setter
    // THROWS on an unknown name, so replaying one would brick every future turn of this session.
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
  return { ...result, context };
}

/**
 * Announce extensions pi failed to load. pi collects them into `LoadExtensionsResult.errors` and
 * carries on with the rest — sound for a TUI that shows them, silent for a server that never looks.
 * A definition running without the extension it ships is exactly the "quietly missing" failure this
 * exists to remove. CHAT calls it, once per built services — serving does not load extensions at
 * all, and announces that instead (see PiAgentSessionFactoryOptions.extensionPaths).
 */
export function reportExtensionErrors(services: AgentSessionServices): void {
  for (const { path, error } of services.resourceLoader.getExtensions().errors) {
    log.warn(`[fastagent] extension ${path} failed to load: ${error}`);
  }
}

/** What pi is allowed to discover, minus the parts each assembly fills in itself. */
type DefinitionLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/**
 * The resource posture a fastagent definition asks pi for — ONE definition of it, for both
 * assemblies. Serving (`piAgentSessionFactory`) and chat (`buildAgentSessionRuntime`) build
 * different sessions on top, but what pi is allowed to DISCOVER is not one of the differences:
 * everything comes from the definition, nothing from the machine that happens to be running it.
 *
 * Two copies of this drifted once already: `additionalExtensionPaths` was added to both, and only
 * one of them also passed the resulting tool names through pi's `tools` allowlist — so extensions
 * worked when served and vanished in chat. A difference between the two has to be visible AS a
 * difference, which is what the parameters are for: serving reads a prompt and skills that change
 * per turn and passes NO extension paths (it does not run them — see
 * {@link PiAgentSessionFactoryOptions.extensionPaths}); chat reads a fixed assembly and passes its
 * own. Both are arguments now, rather than two files that happen to disagree.
 */
export function definitionResourceLoaderOptions(source: {
  systemPrompt: () => string | undefined;
  skills: () => Skill[];
  /** Omitted by serving, which does not run them. */
  extensionPaths?: readonly string[];
}): DefinitionLoaderOptions {
  return {
    // Definition-only, like dev/start: pi's machine-global discovery (the operator's own ~/.pi
    // extensions, slash commands, global AGENTS.md, APPEND_SYSTEM.md) stays out, so the agent that
    // runs is the artifact, not the artifact plus whoever's laptop it is.
    noExtensions: true,
    // ...except the definition's OWN extensions/: pi honours additionalExtensionPaths even under
    // noExtensions, which is exactly the split wanted here — the artifact travels with its
    // extensions, the machine's stay out.
    ...(source.extensionPaths?.length ? { additionalExtensionPaths: [...source.extensionPaths] } : {}),
    noPromptTemplates: true,
    noContextFiles: true,
    // A SPACE, not "", when the assembly has no prompt: pi treats an empty custom prompt as absent
    // and substitutes its own coding-assistant identity, which an L1 agent
    // (`createPiAgent({ model, tools })`) never asked for. pi appends its own working-directory line
    // either way — that is engine behaviour this binding does not fight.
    systemPromptOverride: () => source.systemPrompt() ?? " ",
    appendSystemPromptOverride: () => [],
    skillsOverride: (base) => ({
      skills: toPiSkills(source.skills()) as typeof base.skills,
      diagnostics: base.diagnostics,
    }),
  };
}

/** Open-or-create the record, then bind a fresh session to it. One call per invoke. */
export function piAgentSessionFactory(options: PiAgentSessionFactoryOptions): PiAgentSessionFactory {
  const { sessions, thinkingLevel, cwd, env } = options;
  const extensionPaths = options.extensionPaths ?? [];
  const excludedToolNames = options.excludedToolNames ?? [];
  if (extensionPaths.length > 0) {
    log.warn(
      `[fastagent] ${extensionPaths.length} extension(s) in the definition are NOT loaded when serving ` +
        "(they run in `fastagent chat`): pi's extension runtime is shared across sessions, and serving " +
        "runs concurrent turns for different conversations. See docs/configuration.md#extensions.",
    );
  }
  const tools = options.tools ?? [];
  // What the shared ResourceLoader serves, refreshed per turn before the session is built.
  let prompt = typeof options.systemPrompt === "function" ? options.systemPrompt() : options.systemPrompt;
  let skills = options.skills ?? [];
  let services: Promise<AgentSessionServices> | undefined;
  let engine: Promise<{ modelRuntime: ModelRuntime; model: AnyModel }> | undefined;

  const buildServices = async (modelRuntime: ModelRuntime): Promise<AgentSessionServices> =>
    createAgentSessionServices({
      cwd,
      agentDir: options.agentDir ?? join(cwd, ".fastagent", "pi"),
      modelRuntime,
      // No extensionPaths: serving does not run them (see PiAgentSessionFactoryOptions), which is
      // the one resource question the two assemblies answer differently. The accessors read the
      // CURRENT prompt/skills — serving refreshes both per turn, so a snapshot taken here would
      // serve a stale definition after the first edit.
      resourceLoaderOptions: definitionResourceLoaderOptions({
        systemPrompt: () => prompt,
        skills: () => skills,
      }),
    });

  return async (sessionId, inherit) => {
    const fresh = options.live ? await options.live() : undefined;
    const nextPrompt = fresh
      ? fresh.systemPrompt
      : typeof options.systemPrompt === "function"
        ? options.systemPrompt()
        : prompt;
    const nextSkills = fresh ? (fresh.skills ?? []) : skills;
    engine ??= options.engine();
    const { modelRuntime, model } = await engine;
    if (services === undefined) {
      prompt = nextPrompt;
      skills = nextSkills;
      services = buildServices(modelRuntime); // assigned before any await: concurrent turns share it
    } else {
      // The ResourceLoader reads the overrides once and caches, so a re-read of the definition only
      // reaches the model after a reload. Reload only when the definition ACTUALLY changed — an
      // author edits persona.md far less often than the agent takes a turn, and a reload costs ~5ms
      // against ~0.6ms to bind a session.
      //
      // "Changed" is measured against the LOADER, not against what this factory last wrote. Serving
      // is concurrent across sessions, and a shared variable makes the check lie: one turn writes
      // its new prompt, awaits before reloading, and the next turn sees that value already present,
      // concludes nothing changed, and skips the reload — so the edit reaches neither the loader nor
      // any error. Asking the loader what it is actually serving cannot go stale that way. The cost
      // of losing the race is one redundant reload, not a swallowed edit.
      //
      // Skill CONTENT is not part of this — pi reads a skill from its file at invocation time, so
      // only the declared set matters.
      //
      // What this deliberately does NOT provide is a per-turn snapshot. The definition is an AGENT
      // property, not a session one: two turns running either side of an edit each get a definition
      // that genuinely existed, and the product promise — an edit is live on the next turn — holds
      // for both. Pinning a snapshot per turn would cost either a loader per turn or a queue in
      // front of every bind, to buy a guarantee nothing asks for.
      const loader = (await services).resourceLoader;
      const definitionChanged =
        loader.getSystemPrompt() !== nextPrompt || loadedSkillSet(loader.getSkills().skills) !== skillSet(nextSkills);
      if (definitionChanged) {
        prompt = nextPrompt;
        skills = nextSkills;
        await loader.reload();
      }
    }
    const sessionManager: SessionManager = await sessions.openOrCreate(sessionId, inherit);
    // What the session RUNS on: the boundary plane records model/thinking overrides as entries, and
    // pi does not read them back — a binding that ignored them would silently run every turn on the
    // assembly default, and `state()` would report a setting no turn uses.
    // The SAME read the control plane performs, including its integrity check: a record whose chain
    // is broken must not run on assembly defaults while `state()` rejects it — one of the two planes
    // would be lying. A throw here becomes this turn's `failed` event, which is where the fault has
    // a channel to be reported through.
    const settings = resolveSessionSettings(activePath(sessionManager), modelRuntime, {
      model,
      thinkingLevel: thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    });
    const { session } = await bindPiSession({
      services: await services,
      sessionManager,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      tools,
      env,
      cwd,
      excludedToolNames,
      sessionId,
      recordActivations: true,
    });
    return session;
  };
}

/** What a reload has to notice: the declared set, not the files behind it. */
function skillSet(skills: Skill[]): string {
  return skills.map((s) => `${s.name}\u0000${s.filePath}\u0000${s.description}`).join("\u0001");
}

/** The same signature, read back off the loader. */
function loadedSkillSet(skills: readonly { name: string; filePath?: string; description: string }[]): string {
  return skills.map((s) => `${s.name}\u0000${s.filePath ?? ""}\u0000${s.description}`).join("\u0001");
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
