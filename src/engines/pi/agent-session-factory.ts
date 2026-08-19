/**
 * The AgentSession L0's engine binding: fastagent's assembled agent — model, prompt, skills, tools —
 * bound to one durable record, per invoke.
 *
 * The harness path's counterpart is `piHarnessFactory`; the chat path builds the same pi class from
 * the same assembly (session-builder.ts) but keeps ONE resident session. What is specific here is
 * the posture: many sessions, one turn each, nothing in memory between turns.
 *
 * Shared once, rebuilt per turn:
 * - `services` (ResourceLoader, settings, model runtime) is built lazily and reused — it is the
 *   expensive half, and it holds nothing session-specific;
 * - the `AgentSession` and its tool bindings are per turn, because a tool's `execute` closes over the
 *   session it runs in and this posture has several in flight at once.
 */
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
import type { PiSessionRecordStore } from "./session-store.ts";
import { isDeferredTool, type MountedTool } from "./tool.ts";
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
  /** Filesystem/process environment handed to pi's default coding tools. */
  env: ExecutionEnv;
}

/**
 * The turn's {@link ToolActivation} over a live session — the AgentSession sibling of invoke.ts's
 * harness bridge, so the same built-in `search_tools` serves both.
 *
 * NOT persisted, unlike the harness path, which records each activation in the session and restores
 * it per invoke. pi's chat session has the same gap and states it; closing it here needs a session
 * entry of our own, which belongs with the rest of the activation work rather than in this binding.
 * The consequence is bounded: a deferred tool discovered in one turn is deferred again in the next.
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
        if (added.length > 0) session.setActiveToolsByName([...current, ...added]);
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
        { cwd, sessionManager: agentSessionManager(session), tools: sessionToolActivation(session) },
        // pi's own fifth `execute` parameter is read only by its default coding tools; fastagent's
        // take theirs from turnContext. This env is here to satisfy the shape.
        () => tool.execute(id, params, signal, undefined, { env }) as Promise<unknown>,
      );
    },
  })) as unknown as ToolDefinition[];
}

/** Open-or-create the record, then bind a fresh session to it. One call per invoke. */
export function piAgentSessionFactory(options: PiAgentSessionFactoryOptions): PiAgentSessionFactory {
  const { sessions, thinkingLevel, cwd, env } = options;
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
      modelRuntime,
      resourceLoaderOptions: {
        // The agent is the definition, not the authoring machine's pi setup: no ~/.pi extensions,
        // slash commands, global AGENTS.md or APPEND_SYSTEM.md (same posture as dev/start).
        noExtensions: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPromptOverride: () => prompt ?? "",
        appendSystemPromptOverride: () => [],
        skillsOverride: (base) => ({ skills: toPiSkills(skills) as typeof base.skills, diagnostics: base.diagnostics }),
      },
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
      if (
        loader.getSystemPrompt() !== nextPrompt ||
        loadedSkillSet(loader.getSkills().skills) !== skillSet(nextSkills)
      ) {
        prompt = nextPrompt;
        skills = nextSkills;
        await loader.reload();
      }
    }
    const sessionManager: SessionManager = await sessions.openOrCreate(sessionId, inherit);
    const bound: { session?: AgentSession } = {};
    const { session } = await createAgentSessionFromServices({
      services: await services,
      sessionManager,
      model,
      thinkingLevel,
      customTools: toolDefinitions(tools, cwd, env, bound),
    });
    bound.session = session;
    // Deferral: pi starts every mounted tool active, so narrow by SUBTRACTING the deferred names
    // (robust to pi mounting tools of its own, unlike an exact-set replacement).
    if (deferred.length > 0) {
      const active = session.getActiveToolNames();
      if (deferred.some((name) => active.includes(name))) {
        session.setActiveToolsByName(active.filter((name) => !deferred.includes(name)));
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
