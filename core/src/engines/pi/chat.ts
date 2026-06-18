/**
 * Chat: open a workspace into pi's interactive TUI (`fastagent chat`).
 *
 * `chat` is a pi-specific COMMAND, beside dev.ts/start.ts — NOT an engine-neutral channel. The HTTP
 * channel (channels/http.ts) consumes only the Agent contract (agent.ts), so it works with any
 * engine; `chat` instead drives pi's full session API (`InteractiveMode` — editor, streaming
 * render, tool-call display, slash commands, model cycling, session tree/fork, compaction) and
 * never touches the contract. It HAS to be engine-coupled: the contract is a minimal turn-based
 * `invoke`, while a real TUI needs the engine's whole session lifecycle — forcing it through the
 * contract would collapse it to the crude REPL this command exists to avoid. chat trades
 * neutrality for fidelity, so it lives under engines/pi/ (and is not re-exported from index.ts).
 *
 * FIDELITY CONTRACT — chat must run the SAME agent dev/start serve, not pi's vanilla discovery.
 * pi's DefaultResourceLoader would walk AGENTS.md up to the repo root and discover skills under its
 * own `.pi/skills`/`.agents/skills` convention — neither matches fastagent's "the agent is its
 * folder" (dir-only AGENTS.md + `skills/` + `tools/`). So we INJECT fastagent's assembly into pi's
 * session:
 *   - model      → fromServices({ model })            (fastagent's flag>env>config resolution)
 *   - prompt     → resourceLoaderOptions.systemPromptOverride = fastagent's base + instructions
 *                  ONLY; pi appends the skill section and env (date/cwd) itself, so including them
 *                  here would duplicate both. The result equals what dev/start serve (pi's skill/env
 *                  renderers are the ones assembleSystemPrompt mirrors).
 *   - skills     → resourceLoaderOptions.skillsOverride  (fastagent's skills, for the section + invocation)
 *   - tools      → default coding tools by NAME (pi rebuilds them cwd-bound, keeping its rich TUI
 *                  rendering) + fastagent's custom tools registered via pi's customTools path, so
 *                  they survive the TUI rebuilding the session on /new, /resume, and fork
 *
 * Auth/login, model HTTP, and same-workspace sessions ride pi's native machinery on purpose (the
 * login dialog, OAuth, and /resume are part of the "real harness" experience this command exists to
 * show). Cross-workspace session switches are rejected: `.env` is process-global, so one chat TUI is
 * one workspace; run `fastagent chat <other-dir>` for another workspace.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
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
import { loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { assembleSystemPrompt, piBasePrompt, piDefaultTools, resolveTools } from "./create.ts";
import { defaultGlobalSkillPaths, loadAgentDefinition } from "./definition.ts";
import { loadTools, mergeDiscoveredTools, type ToolCollision } from "./tool.ts";

export interface RunPiChatOptions {
  /** Model spec override (the CLI --model flag). Precedence: this > FASTAGENT_MODEL > config.model. */
  model?: string;
  /** Also load the machine's global skills on top of the definition's own (authoring-fidelity opt-in). */
  globalSkills?: boolean;
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
  async function resolveAssembly(cwd: string) {
    const { config } = await loadConfig(cwd);
    const modelSpec = resolveModelSpec(options.model, config);
    if (!modelSpec) {
      throw new Error(
        `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
      );
    }
    const model = resolveModel(modelSpec);
    const env = new NodeExecutionEnv({ cwd });
    const definition = await loadAgentDefinition(cwd, {
      env,
      skillPaths: options.globalSkills ? defaultGlobalSkillPaths() : [],
    });
    reportDefinitionWarnings(definition.collisions, definition.diagnostics);

    // Same tool resolution as the dev opener (defaults + config.tools + discovered tools/, deduped),
    // then split: defaults go to pi by NAME (so pi rebuilds them cwd-bound, keeping rich TUI
    // rendering); customs go through pi's `customTools` path so they survive /new, /resume, fork.
    const discovered = await loadTools(cwd);
    const { tools, collisions: crossCollisions } = mergeDiscoveredTools(resolveTools(config, cwd), discovered.tools);
    reportToolCollisions([...discovered.collisions, ...crossCollisions]);
    const defaultNames = piDefaultTools(cwd).map((t) => t.name);
    const customTools = tools.filter((t) => !defaultNames.includes(t.name));
    // Adapt fastagent's AgentTool to pi's ToolDefinition. (`parameters` is plain JSON-Schema; pi
    // accepts it. The extra execute args onUpdate/ctx are unused by fastagent tools.)
    const customToolDefs = customTools.map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description ?? "",
      parameters: t.parameters,
      execute: (id: string, params: unknown, signal: AbortSignal | undefined) => t.execute(id, params, signal),
    })) as unknown as ToolDefinition[];

    // base + instructions ONLY. pi appends the skill section (from skillsOverride) and the env
    // (date/cwd) itself; including them here would duplicate both — chat must match what dev/start
    // serve, and pi's renderers are the ones fastagent's assembleSystemPrompt mirrors.
    const systemPrompt = assembleSystemPrompt({
      base: piBasePrompt({ tools }),
      instructions: definition.instructions,
      instructionsPath: definition.instructions !== undefined ? join(cwd, "AGENTS.md") : undefined,
    });

    return { model, definition, defaultNames, customTools, customToolDefs, systemPrompt };
  }

  // pi calls the factory again on /new, /resume, switch, and fork. Dynamic imports for config/tools
  // are cached by Node, so trying to treat same-cwd rebuilds as hot reload would silently produce a
  // half-fresh agent (new AGENTS.md/skills from fs, stale config/tools from ESM cache). Keep chat a
  // coherent startup snapshot instead: restart `fastagent chat` to load edits.
  //
  // Also keep chat workspace-scoped. `.env` is process-global and is loaded by the CLI for the
  // startup workspace; switching the same TUI process to another cwd would either inherit those env
  // values or require mutating global env at runtime (secrets/leakage footgun). Fail visibly and ask
  // the user to run a separate `fastagent chat <dir>` for that workspace.
  const rootCwd = resolve(dir);
  let assembly: Promise<Awaited<ReturnType<typeof resolveAssembly>>> | undefined;
  const assemblyFor = (cwd: string) => {
    const activeCwd = resolve(cwd);
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
        // Definition-only, like dev/start: suppress pi's machine-global discovery (the developer's
        // own ~/.pi extensions, slash commands, and global AGENTS.md) so chat runs the SAME agent
        // that gets served, not the authoring machine's pi setup layered on top.
        noExtensions: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPromptOverride: () => systemPrompt,
        // Replace pi's discovered skills with fastagent's resolved skills (so the agent's skills are
        // invocable and match the prompt's listing). fastagent's Skill (pi-agent-core: content
        // inline) is reshaped to pi-coding-agent's (read from filePath/baseDir at invocation time).
        skillsOverride: (base) => ({
          skills: definition.skills.map((s) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
            baseDir: dirname(s.filePath),
            sourceInfo: { path: s.filePath, source: "fastagent", scope: "project", origin: "top-level", baseDir: dirname(s.filePath) },
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

function reportDefinitionWarnings(
  collisions: { name: string; winnerPath: string; loserPath: string }[],
  diagnostics: { code: string; message: string; path: string }[],
): void {
  for (const c of collisions) {
    console.error(`[fastagent] warn: skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
  }
  for (const d of diagnostics) {
    console.error(`[fastagent] warn: ${d.code}: ${d.message} (${d.path})`);
  }
}

function reportToolCollisions(collisions: ToolCollision[]): void {
  for (const c of collisions) {
    console.error(`[fastagent] warn: tool "${c.name}" (${c.source}) dropped — a default/config tool already uses that name`);
  }
}

function workspaceScopeError(targetCwd: string): Error {
  return new Error(`fastagent chat is workspace-scoped: cannot switch to ${targetCwd}; run \`fastagent chat ${targetCwd}\` instead`);
}

function readSessionHeaderCwd(sessionPath: string): string | undefined {
  const resolvedPath = resolve(sessionPath);
  if (!existsSync(resolvedPath)) return undefined;
  for (const line of readFileSync(resolvedPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
      if (entry.type === "session") return typeof entry.cwd === "string" ? resolve(entry.cwd) : undefined;
    } catch {
      // Ignore malformed lines the same way pi's session loader does; no header cwd → caller pins root.
    }
  }
  return undefined;
}

/**
 * Keep resume/import inside the chat's single workspace, deciding BEFORE delegating to pi. pi tears
 * down the active session before invoking the runtime factory, so a factory-only guard would leave
 * the TUI on an invalidated session when it rejects. We always pin pi's effective cwd to rootCwd:
 * a session that explicitly records a different workspace is rejected up front, while a session with
 * no cwd (legacy/imported files) runs in the chat workspace instead of falling back to pi's
 * `process.cwd()` (which, when chat was launched from outside <dir>, would itself force a
 * cross-workspace rebuild and tear the live session down).
 */
function enforceWorkspaceScopedSessionSwitches(runtime: AgentSessionRuntime, rootCwd: string): void {
  const pinnedTargetCwd = (sessionPath: string, cwdOverride: string | undefined): string => {
    const known = cwdOverride !== undefined ? resolve(cwdOverride) : readSessionHeaderCwd(sessionPath);
    if (known !== undefined && known !== rootCwd) throw workspaceScopeError(known);
    return rootCwd;
  };

  const switchSession = runtime.switchSession.bind(runtime);
  runtime.switchSession = async (...args: Parameters<AgentSessionRuntime["switchSession"]>) => {
    const [sessionPath, options] = args;
    return switchSession(sessionPath, { ...options, cwdOverride: pinnedTargetCwd(sessionPath, options?.cwdOverride) });
  };

  const importFromJsonl = runtime.importFromJsonl.bind(runtime);
  runtime.importFromJsonl = async (...args: Parameters<AgentSessionRuntime["importFromJsonl"]>) => {
    const [inputPath, cwdOverride] = args;
    return importFromJsonl(inputPath, pinnedTargetCwd(inputPath, cwdOverride));
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
