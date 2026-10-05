/**
 * The shared definition-aware session builder: open a directory's assembled agent as a resident pi
 * `AgentSessionRuntime`, running the SAME agent that `dev`/`start` serve.
 */
import { dirname, resolve } from "node:path";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { bindPiSession, definitionServices } from "./agent-session-factory.ts";
import { missingDefaultModel, resolveModel } from "./config.ts";
import { canonicalPath } from "./definition.ts";
import { reportToolCollisions } from "./report.ts";
import { assembleFront, resolveAgentAssembly } from "./open.ts";
import { resolveAgentDir } from "../../paths.ts";

export interface BuildSessionRuntimeOptions {
  /** Model spec override (the CLI --model flag). */
  model?: string;
  /** Credentials file override (the SDK `authPath` option; the CLI has only `FASTAGENT_AUTH_PATH`). */
  authPath?: string;
}

/**
 * Build pi's interactive runtime over the SAME assembly `dev`/`start` serve ({@link assembleFront}): model
 * registry, prompt, tools, skills, reasoning effort and credentials all come from it, so what differs is only the
 * session's shape (one resident runtime rather than one session per invoke).
 */
export async function buildAgentSessionRuntime(
  dir: string,
  options: BuildSessionRuntimeOptions = {},
  sessionManager?: SessionManager,
): Promise<AgentSessionRuntime> {
  // One spelling of the agent directory, whichever path opened it: it names the agent's session directory below, and a
  // tool must see one spelling of it.
  const front = await resolveAgentAssembly(canonicalPath(resolveAgentDir(dir)), options);
  // chat's TUI always starts a conversation, so it needs the default the served agent can do without.
  const modelSpec = front.modelSpec;
  if (!modelSpec) throw missingDefaultModel();
  reportToolCollisions(front.toolCollisions);
  const { dirs } = front;
  // Built once: pi calls the factory again on /new, /resume, switch, and fork, and a rebuild keeps the startup
  // snapshot, because config and tools stay in the import cache and a half-refreshed agent is worse than a stale one.
  // Restart chat to pick up edits.
  const { assembly } = await assembleFront(front);
  const definition = await assembly.readDefinition();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    // Every session here runs in the working directory: /new and fork keep the runtime's, and switches and imports
    // are pinned to it ({@link keepSessionsInAgent}).
    if (canonicalPath(cwd) !== canonicalPath(dirs.cwd)) {
      throw new Error(`this chat runs ${dirs.agentDir} in ${dirs.cwd}: it cannot open a session in ${cwd}`);
    }
    // Per session, NOT memoized with the assembly.
    const modelRuntime = await assembly.createModelRuntime();
    const loaded = await definitionServices({
      dirs,
      modelRuntime,
      definition,
      extensionPaths: assembly.extensionPaths,
    });
    // ...while the SESSION keeps pi's own file-backed settings, on the agent directory wherever it works, so `/settings`
    // in the TUI saves to `<agent dir>/.pi/settings.json`. pi persists by re-reading the file under its lock and writing
    // only the fields that changed, so `packages` there is untouched.
    const services = { ...loaded, settingsManager: SettingsManager.create(dirs.agentDir, loaded.agentDir) };

    // AFTER the services, because an extension may be what defines the model.
    const model = resolveModel(modelRuntime, modelSpec);
    // Serving and chat restore the same native transcript declarations.
    const result = await bindPiSession({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      // Always set, never left for pi to fill: pi resolves an ABSENT level from the machine's settings, and the effort
      // is the definition's (`thinkingLevel` in fastagent.config.ts), like serving's.
      thinkingLevel: assembly.thinkingLevel,
      tools: assembly.tools,
      excludedToolNames: assembly.excludedToolNames,
      dirs,
      contexts: assembly.contexts,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  // The agent's records live in pi's session directory for the AGENT directory, wherever it works: a record belongs to
  // the directory that stores it, so two agents sharing a working directory never see each other's.
  const initial =
    sessionManager ?? SessionManager.create(dirs.cwd, SessionManager.create(dirs.agentDir).getSessionDir());
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: dirs.cwd,
    agentDir: getAgentDir(),
    sessionManager: initial,
  });
  keepSessionsInAgent(runtime, dirs.cwd, initial.getSessionDir());
  return runtime;
}

/**
 * A record belongs to the directory that stores it, not to the cwd its header records. One in this agent's session
 * directory is continued HERE, in the current working directory, whatever its header says (the agent may have worked
 * elsewhere when it was made; serving continues such a record the same way); one stored anywhere else is another
 * agent's. An import is copied into the session directory by pi before it is opened, so it is this agent's by the
 * same rule. Decided BEFORE delegating to pi, which would otherwise rebuild the runtime for the header's cwd.
 */
function keepSessionsInAgent(runtime: AgentSessionRuntime, cwd: string, sessionDir: string): void {
  const switchSession = runtime.switchSession.bind(runtime);
  runtime.switchSession = async (...[sessionPath, options]: Parameters<AgentSessionRuntime["switchSession"]>) => {
    if (canonicalPath(dirname(resolve(sessionPath))) !== canonicalPath(sessionDir)) {
      throw new Error(
        `fastagent sessions belong to one agent: ${sessionPath} is not stored in this agent's sessions (${sessionDir}); open its agent instead`,
      );
    }
    return switchSession(sessionPath, { ...options, cwdOverride: cwd });
  };

  const importFromJsonl = runtime.importFromJsonl.bind(runtime);
  runtime.importFromJsonl = async (...[inputPath]: Parameters<AgentSessionRuntime["importFromJsonl"]>) =>
    importFromJsonl(inputPath, cwd);

  // pi forks at an entry by opening the record's FILE again, which takes no cwd: the copy would run in the cwd its
  // header records. For a record made before the working directory changed that is not where the agent works, and pi
  // has already closed the current session by the time the new one is refused, so it is refused here, first.
  const fork = runtime.fork.bind(runtime);
  runtime.fork = async (...args: Parameters<AgentSessionRuntime["fork"]>) => {
    const recorded = runtime.session.sessionManager.getHeader()?.cwd;
    if (recorded !== undefined && canonicalPath(recorded) !== canonicalPath(cwd)) {
      throw new Error(
        `this conversation was recorded while the agent worked in ${recorded}, and a fork of it would run there; the ` +
          `agent works in ${cwd} now, so continue it, or start a /new one`,
      );
    }
    return fork(...args);
  };
}
