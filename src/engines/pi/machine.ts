/**
 * THE MACHINE an agent runs on, as fastagent inherits it: the skills and prompt templates this box provides — found
 * by pi's own Agent Skills discovery, installed pi packages included — and pi's engine settings.
 *
 * An agent inherits its machine the way it already inherits the `PATH`: `bash` runs whatever is installed, and a
 * skill in `~/.pi/agent/skills` is available the same way. pi's project scope is the agent directory, so what pi reads
 * from a project is the definition's and ships with it; nothing else here is compared against a deployment, the same
 * way nobody is told their local `ffmpeg` is not in the image.
 *
 * READ ONCE per process, like the environment it is. The definition is what stays live (`dev` re-reads it per turn,
 * because it is what an author edits); a skill installed after boot arrives on the next start.
 */
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  type ResolvedResource,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { log } from "../../log.ts";
import { isUnderDir } from "../../paths.ts";
import { PI_PROJECT_RESOURCE_DIRS, canonicalPath } from "./definition.ts";

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
/** pi's own shapes, taken from its loader rather than re-declared. */
export type MachineSkill = ReturnType<DefaultResourceLoader["getSkills"]>["skills"][number];
export type MachinePrompt = ReturnType<DefaultResourceLoader["getPrompts"]>["prompts"][number];

/** The Pi built-in extensions a definition loads, each unless the machine's settings disable it. */
// Not `mcp`: its server connections live as long as a session, and a served session lives one turn, so every turn
// would start every configured server.
export const BUILTIN_EXTENSIONS = ["codemode", "tool-search"] as const;

/**
 * The way in for an authored tool the model is not given up front, by its exposure: the built-in extension that
 * provides it and the tool that extension registers. A `codemode` tool is called from codemode scripts, a `deferred`
 * one is loaded by tool_search — the rule Pi's MCP extension applies to its own tools (`ensureDiscoveryActive`).
 * Without that extension the tool has no way in at all.
 */
export const DISCOVERY = {
  codemode: { extension: "codemode", tool: "codemode" },
  deferred: { extension: "tool-search", tool: "tool_search" },
} as const satisfies Record<string, { extension: (typeof BUILTIN_EXTENSIONS)[number]; tool: string }>;

/** What this box lends an agent. */
export interface Machine {
  skills: MachineSkill[];
  prompts: MachinePrompt[];
  /**
   * The {@link BUILTIN_EXTENSIONS} left enabled, by Pi's own rule: `"extensions": ["-builtin:codemode"]` in the user
   * settings disables one, and the agent directory's `.pi/settings.json` overrides that either way.
   */
  builtinExtensions: string[];
  /** pi's engine settings (retry, compaction, cache warming, …) as read at boot — a fresh manager per caller. */
  settingsManager(): SettingsManager;
}

/** Keyed by the two places it reads: the agent directory (pi's project scope) and pi's own directory (user scope). */
const reads = new Map<string, Promise<Machine>>();

/** This process's one read of the machine, shared by the run plane and `commands()` so the two cannot disagree. */
export function readMachine(agentDir: string): Promise<Machine> {
  // pi's own answer for where its user-level resources live — asked, not spelled, since `PI_CODING_AGENT_DIR` moves it.
  const piDir = getAgentDir();
  const key = `${agentDir}\u0000${piDir}`;
  const cached = reads.get(key);
  if (cached) return cached;
  const reading = read(agentDir, piDir);
  reads.set(key, reading);
  return reading;
}

async function read(agentDir: string, piDir: string): Promise<Machine> {
  const files = SettingsManager.create(agentDir, piDir);
  // pi reads an unparseable or locked settings file as `{}` and keeps the error for whoever asks. Nobody did, so a
  // trailing comma in `~/.pi/agent/settings.json` — or pi's own TUI holding the lock at that moment — left this whole
  // process on pi's defaults, silently: the read happens once.
  for (const { scope, path, error } of files.drainErrors()) {
    log.warn(
      `[fastagent] pi ${scope} settings${path ? ` (${path})` : ""} could not be read, so pi's defaults apply: ${error.message}`,
    );
  }
  // INSTALLED PACKAGES, NEVER AN INSTALL. pi's loader resolves `packages` itself and installs a missing one
  // (`npm install`, `git clone`), throwing out of `reload()` when that fails — measured. So fastagent resolves them
  // here, telling pi to skip what is absent, and hands the loader a packageless copy of the settings so its own
  // resolve has nothing to do.
  const manager = new DefaultPackageManager({
    cwd: agentDir,
    agentDir: piDir,
    settingsManager: files,
    builtinExtensions: [...BUILTIN_EXTENSIONS],
  });
  const packages = await manager.resolve(async () => "skip");
  // A package skipped is said, once: its skills would otherwise just not be there. Asked of the configured list, not
  // of `onMissing` — pi never calls that under `PI_OFFLINE`, so the warning would vanish exactly when offline.
  for (const { source } of manager.listConfiguredPackages().filter((configured) => !configured.installedPath)) {
    log.warn(`[fastagent] pi package ${source} is not installed, so its skills and prompts are not loaded`);
  }
  const settings = {
    global: withoutPackages(files.getGlobalSettings()),
    project: withoutPackages(files.getProjectSettings()),
  };
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir: piDir,
    settingsManager: scopedSettings(settings),
    additionalSkillPaths: fromPackages(packages.skills),
    additionalPromptTemplatePaths: fromPackages(packages.prompts),
    // The machine's extensions are its owner's setup, not this agent's (agent-session-factory.ts loads only the
    // definition's own); context files come from the agent's contexts.
    noExtensions: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { skills, diagnostics: skillDiagnostics } = loader.getSkills();
  const { prompts, diagnostics: promptDiagnostics } = loader.getPrompts();
  // pi's project scope is the agent directory, so its loader also finds the definition's own `.pi/skills`,
  // `.agents/skills` and `.pi/prompts`. Those are the definition's (definition.ts reads them, with its own precedence
  // and reports); the machine keeps what lies outside them: `.agents/skills` above the agent directory, packages, and
  // pi's user scope.
  const definitionOwns = (kind: keyof typeof PI_PROJECT_RESOURCE_DIRS, path: string): boolean =>
    PI_PROJECT_RESOURCE_DIRS[kind].some((dir) => isUnderDir(canonicalPath(path), canonicalPath(join(agentDir, dir))));
  // Said once — this is the process's only read. A `SKILL.md` with no description, or a prompt template whose
  // frontmatter does not parse, is otherwise simply absent.
  for (const [kind, diagnostics] of [
    ["skill", skillDiagnostics],
    ["prompt template", promptDiagnostics],
  ] as const) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.path && definitionOwns(kind === "skill" ? "skills" : "prompts", diagnostic.path)) continue;
      log.warn(
        `[fastagent] ${kind} ${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
      );
    }
  }
  // A `/` in a skill's name names the context it comes from (definition.ts), and pi only warns about one. The
  // machine's own skill spelled that way is left out rather than let collide with a context's.
  const lent = skills.filter((skill) => {
    if (definitionOwns("skills", skill.filePath)) return false;
    if (!skill.name.includes("/")) return true;
    log.warn(
      `[fastagent] machine skill "${skill.name}" (${skill.filePath}) is not loaded: a skill's name may not contain "/", ` +
        `which names the context a skill comes from`,
    );
    return false;
  });
  const builtinExtensions = packages.extensions
    .filter((resource) => resource.enabled && resource.metadata.source === "builtin")
    .map((resource) => resource.path.slice("builtin:".length));
  return {
    skills: lent,
    prompts: prompts.filter((prompt) => !definitionOwns("prompts", prompt.filePath)),
    builtinExtensions,
    settingsManager: () => scopedSettings(settings),
  };
}

/** A package's enabled resources; the loader discovers the top-level ones itself. */
function fromPackages(resources: ResolvedResource[]): string[] {
  return resources.filter((r) => r.enabled && r.metadata.origin === "package").map((r) => r.path);
}

function withoutPackages({ packages: _, ...rest }: Settings): Settings {
  return rest;
}

/**
 * A SettingsManager over the boot snapshot. TWO scopes, not `SettingsManager.inMemory`'s one: pi deep-merges the
 * project file over the global one (a project `retry.enabled` keeps the global `retry.maxRetries`), and flattening
 * them first would change that. A write stays in memory — a served turn never edits the operator's files.
 */
function scopedSettings(snapshot: { global: Settings; project: Settings }): SettingsManager {
  const stored: Record<"global" | "project", string | undefined> = {
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

/** The definition's names win: vendoring a skill into `skills/` is how an author overrides the machine's. */
export function withMachine<Own extends { name: string }, Lent extends { name: string }>(
  own: readonly Own[],
  lent: readonly Lent[],
): (Own | Lent)[] {
  const names = new Set(own.map((item) => item.name));
  return [...own, ...lent.filter((item) => !names.has(item.name))];
}
