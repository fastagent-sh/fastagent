/**
 * The AgentSession L0's engine binding: fastagent's assembled agent — model, prompt, skills, tools — bound to one
 * durable record, per invoke.
 */
import { dirname, join } from "node:path";
import type { Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
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
  /** Where pi looks for ITS settings (retry budget, compaction thresholds, default thinking level). */
  agentDir?: string;
  /**
   * The definition's own extension entry points, for ANNOUNCING that serving does not run them. pi's extension
   * machinery is built for one process serving one session.
   */
  extensionPaths?: string[];
  /** Built-ins omitted by an explicit lower-level tool list. */
  excludedToolNames?: readonly string[];
}

/**
 * The session custom-entry type recording ONE activation delta: `{ names }` — exactly the deferred tools a loader
 * activated in that call.
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

/**
 * Announce extensions pi failed to load. pi collects them into `LoadExtensionsResult.errors` and carries on with the
 * rest.
 */
export function reportExtensionErrors(services: AgentSessionServices): void {
  for (const { path, error } of services.resourceLoader.getExtensions().errors) {
    log.warn(`[fastagent] extension ${path} failed to load: ${error}`);
  }
}

/** What pi is allowed to discover, minus the parts each assembly fills in itself. */
type DefinitionLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/** The resource posture a fastagent definition asks pi for — ONE definition of it, for both assemblies. */
export function definitionResourceLoaderOptions(source: {
  systemPrompt: () => string | undefined;
  skills: () => Skill[];
  /** Omitted by serving, which does not run them. */
  extensionPaths?: readonly string[];
}): DefinitionLoaderOptions {
  return {
    // Definition-only, like dev/start: pi's machine-global discovery (the operator's own ~/.pi extensions, slash
    // commands, global AGENTS.md, APPEND_SYSTEM.md) stays out, so the agent that runs is the artifact, not the
    // artifact plus whoever's laptop it is.
    noExtensions: true,
    // ...except the definition's OWN extensions/: pi honours additionalExtensionPaths even under noExtensions, which
    // is exactly the split wanted here.
    ...(source.extensionPaths?.length ? { additionalExtensionPaths: [...source.extensionPaths] } : {}),
    noPromptTemplates: true,
    noContextFiles: true,
    // A SPACE, not "", when the assembly has no prompt.
    systemPromptOverride: () => source.systemPrompt() || " ",
    appendSystemPromptOverride: () => [],
    skillsOverride: (base) => ({
      skills: toPiSkills(source.skills()) as typeof base.skills,
      diagnostics: base.diagnostics,
    }),
  };
}

/** Open-or-create the record, then bind a fresh session to it. */
export function piAgentSessionFactory(options: PiAgentSessionFactoryOptions): PiAgentSessionFactory {
  const { sessions, thinkingLevel, cwd } = options;
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
  let definition: PiSessionDefinition;
  let services: Promise<AgentSessionServices> | undefined;
  let engine: Promise<{ modelRuntime: ModelRuntime; model: AnyModel }> | undefined;

  const buildServices = async (modelRuntime: ModelRuntime): Promise<AgentSessionServices> =>
    createAgentSessionServices({
      cwd,
      agentDir: options.agentDir ?? join(cwd, ".fastagent", "pi"),
      modelRuntime,
      // No extensionPaths: serving does not run them (see PiAgentSessionFactoryOptions), which is the one resource
      // question the two assemblies answer differently.
      resourceLoaderOptions: definitionResourceLoaderOptions({
        systemPrompt: () => definition.systemPrompt,
        skills: () => definition.skills,
      }),
    });

  return async (sessionId, inherit) => {
    const next = await options.readDefinition();
    engine ??= options.engine();
    const { modelRuntime, model } = await engine;
    if (services === undefined) {
      definition = next;
      services = buildServices(modelRuntime); // assigned before any await: concurrent turns share it
    } else {
      // The ResourceLoader reads the overrides once and caches, so a re-read of the definition only reaches the model
      // after a reload.
      const loader = (await services).resourceLoader;
      const definitionChanged =
        loader.getSystemPrompt() !== (next.systemPrompt || " ") ||
        skillSet(loader.getSkills().skills) !== skillSet(next.skills);
      if (definitionChanged) {
        definition = next;
        await loader.reload();
      }
    }
    const sessionManager: SessionManager = await sessions.openOrCreate(sessionId, inherit);
    // What the session RUNS on: the boundary plane records model/thinking overrides as entries, and pi does not read
    // them back.
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
      cwd,
      excludedToolNames,
      sessionId,
      recordActivations: true,
    });
    return session;
  };
}

/** What a reload has to notice: the declared set, not the files behind it. */
function skillSet(
  skills: readonly { name: string; filePath?: string; description: string; disableModelInvocation?: boolean }[],
): string {
  return skills
    .map((s) => `${s.name}\u0000${s.filePath ?? ""}\u0000${s.description}\u0000${s.disableModelInvocation ?? false}`)
    .join("\u0001");
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
