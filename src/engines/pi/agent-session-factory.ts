/**
 * The AgentSession L0's engine binding: fastagent's assembled agent — model, prompt, skills, tools — bound to one
 * durable record, per invoke.
 */
import { dirname, relative } from "node:path";
import type { AgentCommand } from "../../session.ts";
import { loadAgentSkills } from "./definition.ts";
import { reportFindingsIfChanged } from "./report.ts";
import type { Skill, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type ModelRuntime,
  type SessionManager,
  type ToolDefinition,
  createAgentSessionFromServices,
  DefaultResourceLoader,
  SettingsManager,
  createAgentSessionServices,
  getAgentDir,
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

/** pi's own shapes, taken from the loader rather than re-declared: both carry a `filePath` this file classifies by. */
type DiscoveredSkill = ReturnType<DefaultResourceLoader["getSkills"]>["skills"][number];
type DiscoveredPrompt = ReturnType<DefaultResourceLoader["getPrompts"]>["prompts"][number];

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

/** pi's settings files as read at boot, per scope — pi merges them, so they stay apart here. */
interface MachineSettings {
  global: Settings;
  project: Settings;
}

/** What the box lends an agent, read once per process. */
interface MachineResources {
  skills: DiscoveredSkill[];
  prompts: DiscoveredPrompt[];
  settings: MachineSettings;
}

/**
 * A SettingsManager over a snapshot: pi's `reload()` re-reads THIS rather than the files, and a write stays in
 * memory — a served turn never edits the operator's `~/.pi/agent/settings.json`.
 */
function settingsFrom(snapshot: MachineSettings): SettingsManager {
  const stored: Record<keyof MachineSettings, string | undefined> = {
    global: JSON.stringify(snapshot.global),
    project: JSON.stringify(snapshot.project),
  };
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      const next = fn(stored[scope]);
      if (next !== undefined) stored[scope] = next;
    },
  });
}

/**
 * The snapshot minus pi `packages`. Resolving one INSTALLS it when it is missing (`npm install`, `git clone`), and a
 * failed install throws out of `reload()`.
 */
function withoutPackages({ global, project }: MachineSettings): MachineSettings {
  const strip = ({ packages: _, ...rest }: Settings): Settings => rest;
  return { global: strip(global), project: strip(project) };
}

/** Keyed by the two directories it reads: the workspace (project-level) and pi's own (user-level). */
const machineReads = new Map<string, Promise<MachineResources>>();

/**
 * THE machine's half, read ONCE and handed to both planes.
 *
 * Two things made this a function rather than two reads. The listing was live while the run plane's loader was
 * not, so `/` could offer a skill installed after boot that the very next prompt would not expand — the menu
 * promising a name the turn did not have. And each listing re-reported the machine's diagnostics, so
 * `GET /control/commands` printed the same warning once per request.
 *
 * NOT LIVE, on purpose: the DEFINITION is what `dev` re-reads per turn, because it is the thing an author is
 * editing. The machine is the environment around it, and a process does not notice a `PATH` entry added after it
 * started either. Restart to pick one up — and a deployment restarts on every release anyway.
 */
export function machineResources(workspace: string): Promise<MachineResources> {
  // pi's own answer for where its user-level resources live, asked rather than spelled: `~/.pi/agent` written
  // here would be a second copy of a convention (and of `PI_CODING_AGENT_DIR`) that belongs to pi.
  const agentDir = getAgentDir();
  const key = `${workspace}\u0000${agentDir}`;
  const cached = machineReads.get(key);
  if (cached) return cached;
  const reading = (async (): Promise<MachineResources> => {
    const files = SettingsManager.create(workspace, agentDir);
    const settings: MachineSettings = { global: files.getGlobalSettings(), project: files.getProjectSettings() };
    // Discovery ONLY — no definition overrides here, because this is the other half. Extensions stay off for the
    // same concurrency reason the serving posture keeps them off.
    const discover = async (snapshot: MachineSettings) => {
      const loader = new DefaultResourceLoader({
        cwd: workspace,
        agentDir,
        settingsManager: settingsFrom(snapshot),
        noExtensions: true,
        noContextFiles: true,
      });
      await loader.reload();
      return loader;
    };
    let loader: DefaultResourceLoader;
    try {
      loader = await discover(settings);
    } catch (error) {
      // THE MACHINE'S HALF DEGRADES; it does not take the definition down with it. A package this box lists but
      // cannot install (offline, a typo, a registry 404) would otherwise fail boot, `info`, `deploy` and every turn
      // — for a skill the agent may never use. Its local skills and prompts still load; restart once it is fixed.
      log.warn(
        `[fastagent] this machine's pi packages could not be resolved, so their skills and prompts are left out ` +
          `until restart: ${error instanceof Error ? error.message : String(error)}`,
      );
      loader = await discover(withoutPackages(settings));
    }
    const { skills, diagnostics } = loader.getSkills();
    // The machine's broken files, said ONCE — this read is the process's only one. A `SKILL.md` with no
    // description in `~/.pi/agent/skills` used to be absent from the prompt, absent from the listing, and silent.
    for (const diagnostic of diagnostics) {
      log.warn(
        `[fastagent] skill ${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
      );
    }
    return { skills, prompts: loader.getPrompts().prompts, settings };
  })();
  machineReads.set(key, reading);
  return reading;
}

/** The resource posture a fastagent definition asks pi for — ONE definition of it, for both assemblies. */
export function definitionResourceLoaderOptions(source: {
  systemPrompt: () => string | undefined;
  skills: () => Skill[];
  /** {@link machineResources} for this workspace — resolved by the caller, because this function is synchronous. */
  machine: MachineResources;
  /** Omitted by serving, which does not run them. */
  extensionPaths?: readonly string[];
}): DefinitionLoaderOptions {
  return {
    /**
     * EXTENSIONS ARE THE EXCEPTION, and the reason is concurrency, not portability: pi's extension runtime is
     * PROCESS-WIDE — every `AgentSession` overwrites the actions on it — while serving runs concurrent turns for
     * conversations that have nothing to do with each other. One turn's `pi.sendMessage()` would deliver into
     * another person's chat (docs/configuration.md#why-serving-does-not-run-them). When pi exports its
     * per-session loader this line goes with the reason.
     */
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
     * THE DEFINITION'S SKILLS, PLUS THE MACHINE'S — an agent inherits the box it runs on, the same way it already
     * inherits the commands on its PATH. `base` is what pi discovered by the Agent Skills standard (the four
     * directories, the package entries, this machine's pi settings); the definition's own win a name collision,
     * because vendoring one in is how an author overrides the machine.
     *
     * A deployed image is a machine too: whatever `~/.pi/agent/skills` it has is the environment its builder chose,
     * and `deploy` reports which of the local ones will not be in it.
     */
    // NO DISCOVERY OF ITS OWN, by either loader: the machine's half comes from {@link machineResources}, the
    // process's single read, so the run plane and `commands()` describe the same box. Letting each loader discover
    // separately is what made the menu live while a bound session was not.
    noSkills: true,
    skillsOverride: () => {
      const own = toPiSkills(source.skills()) as DiscoveredSkill[];
      const names = new Set(own.map((skill) => skill.name));
      return {
        skills: [...own, ...source.machine.skills.filter((skill) => !names.has(skill.name))],
        diagnostics: [],
      };
    },
    noPromptTemplates: true,
    promptsOverride: () => ({ prompts: [...source.machine.prompts], diagnostics: [] }),
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

  const buildServices = async (modelRuntime: ModelRuntime): Promise<AgentSessionServices> => {
    const machine = await machineResources(cwd);
    return createAgentSessionServices({
      cwd,
      modelRuntime,
      // Packageless: this loader discards everything packages contribute (skills and prompts come from the machine
      // read, extensions do not run, there is no TUI to theme), so resolving them would only add a network install,
      // and its failure, to a turn.
      settingsManager: settingsFrom(withoutPackages(machine.settings)),
      // No extensionPaths: serving does not run them (see PiAgentSessionFactoryOptions), which is the one resource
      // question the two assemblies answer differently.
      resourceLoaderOptions: definitionResourceLoaderOptions({
        systemPrompt: () => definition.systemPrompt,
        skills: () => definition.skills,
        machine,
      }),
    });
  };

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
      //
      // AGAINST THE DEFINITION WE LAST APPLIED, never against the loader's skill list: that list is the merge
      // (definition + machine), so comparing the definition's half to it made `definitionChanged` true whenever the
      // machine had any skill at all — a full `reload()` per turn on a loader concurrent turns share, re-scanning
      // pi's resource directories and clearing its extension cache.
      //
      // The MACHINE's half is therefore not live: it is read once, when this process built its services. That is
      // the same deal as the rest of the environment — a `PATH` entry added after a process started does not reach
      // it either — while the DEFINITION stays live, which is the property `dev` is built on.
      const loader = (await services).resourceLoader;
      const definitionChanged =
        loader.getSystemPrompt() !== (next.systemPrompt || " ") ||
        skillSet(definition.skills) !== skillSet(next.skills);
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
    // THE ONLY LISTENER for a fault pi reports nowhere else: `/skill:<name>` is expanded by reading `filePath` at
    // prompt time, and when that read fails pi raises `skill_expansion` on the extension error channel and sends
    // the line to the model unexpanded. Without this the turn is silent about it — the answer just ignores a skill
    // the caller named. The list can outlive the file: it is refreshed per invoke (`readDefinition` above), so a
    // steer or follow-up inside a run, or a definition replaced under a running container
    // (`src/deploy/workspace.ts`), reaches exactly that state.
    //
    // Serving only. It subscribes on THIS session's `ExtensionRunner` (pi's `onError` adds to a per-runner set),
    // but `bindExtensions` also re-emits `session_start` — a no-op here, where no extension is loaded at all, and
    // not something to hand `chat`, whose extensions do run.
    await session.bindExtensions({
      onError: ({ extensionPath, event, error }) =>
        log.warn(`[fastagent] session ${sessionId}: ${event} failed for ${extensionPath}: ${error}`),
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

/**
 * The names a `/` composer completes: the definition's skills, this machine's skills, and its prompt templates.
 *
 * `source` says whether a name TRAVELS, decided by where its file is ({@link commandSource}): inside the
 * workspace it rides into the image, outside it belongs to the box this process runs on. That distinction is the
 * client's only way to warn before someone builds a workflow on a name that disappears in the cloud.
 *
 * The machine's half is {@link machineResources} — the same snapshot a bound session runs on, and pi's own
 * discovery rather than a re-derivation of the standard's directories, so the list and the turn cannot disagree
 * about which names exist.
 */
export async function resolveCommandSurface(agentDir: string, workspace: string): Promise<AgentCommand[]> {
  const own = await loadAgentSkills(agentDir, { cwd: workspace });
  // A skill whose frontmatter broke simply is not in `skills` — it would disappear from the author's composer with
  // no signal anywhere.
  reportFindingsIfChanged(own.dir, own);
  // THE SAME SNAPSHOT a bound session runs on, not a second reading of the same directories: a listing that
  // re-discovered would offer names installed after this process booted, which the next prompt would not expand.
  const machine = await machineResources(workspace);
  const ownNames = new Set(own.skills.map((skill) => skill.name));
  return [
    ...own.skills.map((skill) => ({ name: skill.name, description: skill.description, source: "skill" })),
    ...machine.skills
      .filter((skill) => !ownNames.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: commandSource("skill", skill.filePath, workspace),
      })),
    ...machine.prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description ? { description: prompt.description } : {}),
      source: commandSource("prompt", prompt.filePath, workspace),
    })),
  ];
}

/**
 * Does this name TRAVEL — the one question `source` answers, decided by where its file is.
 *
 * pi discovers project-level `.pi/skills` and `.agents/skills` (and their prompt equivalents) as well as the
 * user-level ones, and those sit INSIDE the workspace: `COPY . .` puts them in the image and the deployed process
 * finds them exactly where it finds them here. Calling them "from this machine" told an author the opposite of
 * what happens, in the one message meant to warn them.
 *
 * NO PATH MEANS MACHINE, deliberately: a name we cannot place is one we cannot promise will be there, and the
 * expensive mistake is the reassuring one. pi declares `filePath` on both shapes today, so the branch is what
 * happens if that ever stops being true rather than something reachable now.
 */
function commandSource(kind: "skill" | "prompt", filePath: string | undefined, workspace: string): string {
  const inside = filePath !== undefined && !relative(workspace, filePath).startsWith("..");
  return inside ? kind : `machine-${kind}`;
}

/** Does this `source` name something that will NOT be in a deployment? */
function isMachineCommand(command: AgentCommand): boolean {
  return command.source.startsWith("machine-");
}

/**
 * The pi settings that change what a TURN does — the ones worth an author's attention when they will not travel.
 * Presentation-only keys (theme, editor, TUI) are the machine's business and stay out of the report;
 * `defaultThinkingLevel` does too, because the definition's `thinkingLevel` overrides it in every posture.
 */
const TURN_SETTINGS = [
  "compaction",
  "retry",
  "cacheWarming",
  "thinkingBudgets",
  "transport",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
] as const;

/** Set to something, as opposed to absent or `{}` — pi treats both of those as its default. */
function isSet(value: unknown): boolean {
  if (value === undefined) return false;
  return !(typeof value === "object" && value !== null && Object.keys(value).length === 0);
}

/** What this machine lends the agent and a deployed image will not have. */
export interface MachineLoan {
  /** Skills and prompt templates from outside the workspace. */
  commands: AgentCommand[];
  /** {@link TURN_SETTINGS} keys set in pi's GLOBAL settings file. */
  settings: string[];
}

/**
 * THE ANSWER to "what does this box lend", for every place that has to say it (AGENTS.md: anything inherited is
 * reported where it stops being true) — `deploy`'s pre-flight, the startup `machine:` line, `info`.
 *
 * Settings are the GLOBAL file's only. The project file is `<workspace>/.pi/settings.json`, inside the workspace,
 * so `COPY . .` carries it and the deployed process reads it from the same place: it travels, the way a project
 * `.pi/skills` does. A global `retry.enabled: false` does not, and without this the deployed agent quietly went
 * back to pi's retry budget with nothing in the deploy to say so.
 */
export async function machineLoan(agentDir: string, workspace: string): Promise<MachineLoan> {
  const commands = (await resolveCommandSurface(agentDir, workspace)).filter(isMachineCommand);
  const { global } = (await machineResources(workspace)).settings;
  return { commands, settings: TURN_SETTINGS.filter((key) => isSet(global[key])) };
}
