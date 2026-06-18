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
 *   - prompt     → resourceLoaderOptions.systemPromptOverride (fastagent's exact served prompt;
 *                  byte-faithful to what HTTP serves — pi's TUI-doc base section is intentionally
 *                  NOT added, so chat == served)
 *   - skills     → resourceLoaderOptions.skillsOverride  (fastagent's skills, for invocation)
 *   - tools      → default coding tools by NAME (pi rebuilds them cwd-bound, keeping its rich TUI
 *                  rendering) + fastagent's custom tools appended to session state (functional; the
 *                  prose listing already lives in the injected system prompt)
 *
 * Auth/login, model HTTP, and sessions ride pi's native machinery on purpose (the login dialog,
 * OAuth, and /resume are part of the "real harness" experience this command exists to show).
 */
import { dirname, join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  InteractiveMode,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type FastagentConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { assembleSystemPrompt, piBasePrompt, piDefaultTools, resolveTools } from "./create.ts";
import { defaultGlobalSkillPaths, loadAgentDefinition } from "./definition.ts";
import { loadTools, mergeDiscoveredTools } from "./tool.ts";

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
  const { config }: { config: FastagentConfig } = await loadConfig(dir);
  const modelSpec = resolveModelSpec(options.model, config);
  if (!modelSpec) {
    throw new Error(
      `missing model: set --model, "model" in fastagent.config.ts, or FASTAGENT_MODEL (e.g. "openai-codex/gpt-5.5")`,
    );
  }
  const model = resolveModel(modelSpec);

  const env = new NodeExecutionEnv({ cwd: dir });
  const definition = await loadAgentDefinition(dir, {
    env,
    skillPaths: options.globalSkills ? defaultGlobalSkillPaths() : [],
  });

  // Same tool resolution as the dev opener (defaults + config.tools + discovered tools/, deduped),
  // then split: defaults go to pi by NAME (rich rendering), customs are appended to session state.
  const discovered = await loadTools(dir);
  const { tools } = mergeDiscoveredTools(resolveTools(config, dir), discovered.tools);
  const defaultNames = piDefaultTools(dir).map((t) => t.name);
  const customTools = tools.filter((t) => !defaultNames.includes(t.name));

  // fastagent's exact served system prompt (re-evaluated per call so the date stays the turn's).
  const systemPrompt = (): string =>
    assembleSystemPrompt({
      base: piBasePrompt({ tools }),
      instructions: definition.instructions,
      instructionsPath: definition.instructions !== undefined ? join(dir, "AGENTS.md") : undefined,
      skills: definition.skills,
      date: new Date().toISOString().slice(0, 10),
      cwd: dir,
    });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: {
        // Definition-only, like dev/start: suppress pi's machine-global discovery (the developer's
        // own ~/.pi extensions, slash commands, and global AGENTS.md) so chat runs the SAME agent
        // that gets served, not the authoring machine's pi setup layered on top.
        noExtensions: true,
        noPromptTemplates: true,
        noContextFiles: true,
        systemPromptOverride: () => systemPrompt(),
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
      tools: defaultNames,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir: getAgentDir(),
    sessionManager: sessionManager ?? SessionManager.create(dir),
  });

  // Mount fastagent's custom tools functionally. Appended (not replaced) so the default tools keep
  // pi's built-in rich rendering; the customs' prose already lives in the injected system prompt.
  if (customTools.length > 0) {
    runtime.session.agent.state.tools = [...runtime.session.agent.state.tools, ...customTools];
  }
  return runtime;
}

/**
 * Open the workspace's agent in pi's interactive TUI and run until the user exits. The agent is
 * fastagent's assembled agent (same model/tools/skills/prompt as dev/start serve); pi's TUI handles
 * login, rendering, sessions, and /resume natively.
 */
export async function runPiChat(dir: string, options: RunPiChatOptions = {}): Promise<void> {
  const runtime = await buildChatRuntime(dir, options);
  await new InteractiveMode(runtime, {}).run();
}
