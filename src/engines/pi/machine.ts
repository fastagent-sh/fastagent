/**
 * THE MACHINE an agent runs on, as fastagent inherits it: the skills and prompt templates this box provides — found
 * by pi's own Agent Skills discovery, installed pi packages included — and pi's engine settings.
 *
 * An agent inherits its machine the way it already inherits the `PATH`: `bash` runs whatever is installed, and a
 * skill in `~/.pi/agent/skills` is available the same way. Deploying ships the project scope — the workspace — and
 * nothing here is compared against a deployment, the same way nobody is told their local `ffmpeg` is not in the image.
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
import { log } from "../../log.ts";

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
/** pi's own shapes, taken from its loader rather than re-declared. */
export type MachineSkill = ReturnType<DefaultResourceLoader["getSkills"]>["skills"][number];
type MachinePrompt = ReturnType<DefaultResourceLoader["getPrompts"]>["prompts"][number];

/** What this box lends an agent. */
export interface Machine {
  skills: MachineSkill[];
  prompts: MachinePrompt[];
  /** pi's engine settings (retry, compaction, cache warming, …) as read at boot — a fresh manager per caller. */
  settingsManager(): SettingsManager;
}

/** Keyed by the two places it reads: the workspace (project scope) and pi's own directory (user scope). */
const reads = new Map<string, Promise<Machine>>();

/** This process's one read of the machine, shared by the run plane and `commands()` so the two cannot disagree. */
export function readMachine(workspace: string): Promise<Machine> {
  // pi's own answer for where its user-level resources live — asked, not spelled, since `PI_CODING_AGENT_DIR` moves it.
  const agentDir = getAgentDir();
  const key = `${workspace}\u0000${agentDir}`;
  const cached = reads.get(key);
  if (cached) return cached;
  const reading = read(workspace, agentDir);
  reads.set(key, reading);
  return reading;
}

async function read(workspace: string, agentDir: string): Promise<Machine> {
  const files = SettingsManager.create(workspace, agentDir);
  // INSTALLED PACKAGES, NEVER AN INSTALL. pi's loader resolves `packages` itself and installs a missing one
  // (`npm install`, `git clone`), throwing out of `reload()` when that fails — measured. So fastagent resolves them
  // here, telling pi to skip what is absent, and hands the loader a packageless copy of the settings so its own
  // resolve has nothing to do. A package skipped is said, once: its skills would otherwise just not be there.
  const packages = await new DefaultPackageManager({ cwd: workspace, agentDir, settingsManager: files }).resolve(
    async (source) => {
      log.warn(`[fastagent] pi package ${source} is not installed, so its skills and prompts are not loaded`);
      return "skip";
    },
  );
  const settings = {
    global: withoutPackages(files.getGlobalSettings()),
    project: withoutPackages(files.getProjectSettings()),
  };
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager: scopedSettings(settings),
    additionalSkillPaths: fromPackages(packages.skills),
    additionalPromptTemplatePaths: fromPackages(packages.prompts),
    // Extensions stay off for the concurrency reason serving keeps them off (agent-session-factory.ts);
    // context files are fastagent's own (segment ②).
    noExtensions: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  // Said once — this is the process's only read. A `SKILL.md` with no description is otherwise simply absent.
  for (const diagnostic of diagnostics) {
    log.warn(
      `[fastagent] skill ${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
    );
  }
  return { skills, prompts: loader.getPrompts().prompts, settingsManager: () => scopedSettings(settings) };
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
