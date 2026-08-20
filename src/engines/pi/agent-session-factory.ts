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
import { join } from "node:path";
import type { ExecutionEnv, Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionServices,
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
import { type ToolActivation, additiveActivation, agentSessionManager, turnContext } from "./tool-context.ts";

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
  /** The definition's own extension entry points (see {@link LoadedDefinition.extensionPaths}). Handed
   *  to pi as `additionalExtensionPaths`, which is honoured even under `noExtensions: true` — so the
   *  definition's extensions load while the authoring machine's `~/.pi` ones stay out. */
  extensionPaths?: string[];
  /** Filesystem/process environment handed to pi's default coding tools. */
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
 * The turn's {@link ToolActivation} over a live session — the same bridge chat uses, so one
 * built-in `search_tools` serves both.
 *
 * Activations are PERSISTED as deltas, so a tool discovered in one turn stays callable in the next.
 * pi's own chat session does not do this (it has no place to put the record); a served session does,
 * because the alternative is an agent that re-discovers the same capability every single turn.
 */
function sessionToolActivation(session: AgentSession): ToolActivation {
  // Serialize activations: the read-modify-write below is only race-free while nothing awaits
  // between read and write, and parallel tool calls in one batch would otherwise double-stamp.
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
        if (added.length > 0) {
          session.setActiveToolsByName([...current, ...added]);
          session.sessionManager.appendCustomEntry(TOOL_ACTIVATION_ENTRY, { names: added });
        }
        return added;
      };
      const result = chain.then(run, run);
      chain = result.catch(() => []);
      return result;
    },
  };
}

/**
 * fastagent's tools as pi tool definitions, bound to ONE session.
 *
 * `bound` is filled after the session exists — pi needs the definitions to build the session, and a
 * tool needs the session to reach the turn context. A tool that somehow runs before that binding
 * throws rather than executing outside the turn: a broken lifecycle must not look like a normal
 * out-of-turn call.
 */
function toolDefinitions(
  tools: MountedTool[],
  cwd: string,
  env: ExecutionEnv,
  sessionId: string,
  bound: { session?: AgentSession },
): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    // An activating tool (the built-in loader) declares "sequential" so pi serializes its batch;
    // without it pi's outer active-set diff double-stamps parallel calls.
    executionMode: tool.executionMode,
    execute: (id: string, params: unknown, signal: AbortSignal | undefined) => {
      const session = bound.session;
      if (!session) throw new Error("tool executed before its session was bound (lifecycle invariant broken)");
      return turnContext.run(
        { cwd, sessionManager: agentSessionManager(session, sessionId), tools: sessionToolActivation(session) },
        // pi's own fifth `execute` parameter is read only by its default coding tools; fastagent's
        // take theirs from turnContext. This env is here to satisfy the shape.
        () => tool.execute(id, params, signal, undefined, { env }) as Promise<unknown>,
      );
    },
  })) as unknown as ToolDefinition[];
}

/**
 * Announce extensions pi failed to load. pi collects them into `LoadExtensionsResult.errors` and
 * carries on with the rest — sound for a TUI that shows them, silent for a server that never looks.
 * A definition served without the extension it ships is exactly the "quietly missing" failure this
 * path exists to remove, so the serving and chat assemblies both call this once per built services.
 */
export function reportExtensionErrors(services: AgentSessionServices): void {
  for (const { path, error } of services.resourceLoader.getExtensions().errors) {
    log.warn(`[fastagent] extension ${path} failed to load: ${error}`);
  }
}

/** Open-or-create the record, then bind a fresh session to it. One call per invoke. */
export function piAgentSessionFactory(options: PiAgentSessionFactoryOptions): PiAgentSessionFactory {
  const { sessions, thinkingLevel, cwd, env } = options;
  const extensionPaths = options.extensionPaths ?? [];
  const tools = options.tools ?? [];
  const deferred = tools.filter(isDeferredTool).map((t) => t.name);
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
      resourceLoaderOptions: {
        // The agent is the definition, not the authoring machine's pi setup: no ~/.pi extensions,
        // slash commands, global AGENTS.md or APPEND_SYSTEM.md (same posture as dev/start).
        noExtensions: true,
        // ...except the definition's OWN extensions/: pi honours additionalExtensionPaths even under
        // noExtensions, which is exactly the split we want — the artifact travels with its
        // extensions, the operator's ~/.pi ones stay out.
        ...(extensionPaths.length > 0 ? { additionalExtensionPaths: extensionPaths } : {}),
        noPromptTemplates: true,
        noContextFiles: true,
        // A SPACE, not "", when the assembly has no prompt: pi treats an empty custom prompt as
        // absent and substitutes its own coding-assistant identity, which an L1 agent
        // (`createPiAgent({ model, tools })`) never asked for. pi appends its own working-directory
        // line either way — that is engine behaviour this binding does not fight.
        systemPromptOverride: () => prompt ?? " ",
        appendSystemPromptOverride: () => [],
        skillsOverride: (base) => ({ skills: toPiSkills(skills) as typeof base.skills, diagnostics: base.diagnostics }),
      },
    }).then((built) => {
      reportExtensionErrors(built);
      return built;
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
    const bound: { session?: AgentSession } = {};
    const { session } = await createAgentSessionFromServices({
      services: await services,
      sessionManager,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      // pi would otherwise mount its own read/bash/edit/write ON TOP of ours: fastagent's default
      // tool set already IS those four (create.ts piDefaultTools), so letting both in would offer
      // the model each one twice, under one name.
      noTools: "builtin",
      customTools: toolDefinitions(tools, cwd, env, sessionId, bound),
    });
    bound.session = session;
    // An extension handler that throws is otherwise dropped: pi fans errors out to registered
    // listeners and has none by default, which on a server means a broken extension looks like an
    // extension that simply did nothing.
    //
    // `uiContext` is deliberately NOT bound here. pi defaults it to a no-op, so an extension asking
    // `select`/`confirm`/`input` gets an immediate "no answer" instead of hanging — degraded, but not
    // stuck. Binding a logging stand-in would mean implementing 20+ members of `ExtensionUIContext`,
    // most of them TUI geometry (widgets, footers, editors) that a served agent has no meaning for.
    // The answering channel is a contract question, not a stub: see the `ask`/`answer` design.
    if (extensionPaths.length > 0) {
      await session.bindExtensions({
        onError: (e) => log.warn(`[fastagent] extension ${e.extensionPath} failed on ${e.event}: ${e.error}`),
      });
    }
    // Deferral, then restoration: pi starts every mounted tool active, so narrow by SUBTRACTING the
    // deferred names (robust to pi mounting tools of its own, unlike an exact-set replacement), then
    // add back what THIS session has already discovered.
    if (deferred.length > 0) {
      const active = session.getActiveToolNames();
      const mounted = new Set(session.getAllTools().map((tool) => tool.name));
      const recorded = recordedActivations(session);
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
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.filePath.slice(0, skill.filePath.lastIndexOf("/")),
    sourceInfo: {
      path: skill.filePath,
      source: "fastagent",
      scope: "project",
      origin: "top-level",
      baseDir: skill.filePath.slice(0, skill.filePath.lastIndexOf("/")),
    },
    disableModelInvocation: skill.disableModelInvocation ?? false,
  }));
}
