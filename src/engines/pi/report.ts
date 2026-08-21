/**
 * Render assembly warnings to stderr — the one place both the CLI runners and the `chat` runtime show
 * the non-fatal definition/tool findings the loaders return as data. One copy so the wording can't drift.
 */
import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { log } from "../../log.ts";
import type { LoadedDefinition, SkillCollision } from "./definition.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import type { ToolCollision } from "./tool.ts";

type Findings = { collisions: SkillCollision[]; diagnostics: SkillDiagnostic[] };

/** A non-fatal problem created by the assembled capability surface rather than by parsing one skill. */
export interface AssemblyFinding {
  code: "skills_require_file_reader";
  message: string;
  path: string;
}

/**
 * A model-visible skill is a path-based capability: pi tells the model to read SKILL.md on demand.
 * Without a `read` tool that listing is a dead instruction, so surface the mismatch.
 *
 * Takes the tool NAMES rather than a pre-computed boolean: six callers were each deriving
 * `.includes("read")` on the way in, which is one reading of one rule copied six times. This is the
 * only place in the codebase that still asks what the agent can do with a file — a channel states
 * what it attached and lets the agent answer, but an assembly that lists skills it cannot open is
 * contradicting itself, and only the assembly can see that.
 */
export function definitionAssemblyFindings(
  definition: Pick<LoadedDefinition, "dir" | "skills">,
  codingToolNames: readonly string[],
): AssemblyFinding[] {
  const visible = definition.skills.filter((skill) => !skill.disableModelInvocation);
  return !codingToolNames.includes("read") && visible.length > 0
    ? [
        {
          code: "skills_require_file_reader",
          message: `model-visible skills (${visible.map((skill) => skill.name).join(", ")}) cannot be loaded without the read coding tool; enable codingTools: ["read"] or remove/disable those skills`,
          path: definition.dir,
        },
      ]
    : [];
}

/** Stable identity of a definition's non-fatal findings — the dedup key below. */
function findingsSignature(def: Findings, assembly: readonly AssemblyFinding[]): string {
  const collisions = def.collisions.map((c) => `c:${c.name}:${c.winnerPath}:${c.loserPath}`);
  const diagnostics = def.diagnostics.map((d) => `d:${d.code}:${d.path}`);
  const assembled = assembly.map((d) => `a:${d.code}:${d.path}:${d.message}`);
  return [...collisions, ...diagnostics, ...assembled].sort().join("\n");
}

/**
 * The last reported finding set PER DEFINITION DIR. One memo for every reader of a definition (the
 * per-turn live read, the control plane's command list), because the thing being deduped is the
 * FINDING, not the reader: a newly broken skill deserves one warning, not one per code path that
 * noticed it, and a static one deserves none at all.
 */
const lastFindings = new Map<string, string>();

/**
 * THE door for definition findings: warns only when this dir's set CHANGED since the last report.
 * Every reader calls it — boot, the per-turn live read, the control plane's command list — so a
 * finding is announced when it appears and never repeated. There is deliberately no "record without
 * printing" variant: a memo entry that trusts some other caller to have printed would silently
 * swallow findings for a caller that does not.
 *
 * `dir` must be the RESOLVED definition root (`LoadedDefinition.dir`), or two spellings of one path
 * become two memos and warn twice.
 *
 * `assembly` is REQUIRED, with no default: an omitted argument writes a signature that does not
 * include the assembly findings, so the next caller that does pass them re-warns and an earlier one
 * suppresses them — the "record without printing" variant this module's single door exists to rule
 * out. Callers with nothing to add pass `[]` and say so.
 */
export function reportFindingsIfChanged(dir: string, def: Findings, assembly: readonly AssemblyFinding[]): void {
  const sig = findingsSignature(def, assembly);
  if (lastFindings.get(dir) === sig) return;
  lastFindings.set(dir, sig);
  reportDefinitionWarnings(def.collisions, def.diagnostics);
  for (const finding of assembly) log.warn(`[fastagent] ${finding.code}: ${finding.message} (${finding.path})`);
}

export function reportDefinitionWarnings(collisions: SkillCollision[], diagnostics: SkillDiagnostic[]): void {
  for (const c of collisions) {
    log.warn(`[fastagent] skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
  }
  for (const d of diagnostics) {
    log.warn(`[fastagent] ${d.code}: ${d.message} (${d.path})`);
  }
}

export function reportToolCollisions(collisions: ToolCollision[]): void {
  for (const c of collisions) {
    log.warn(`[fastagent] tool "${c.name}" (${c.source}) dropped — a default/config tool already uses that name`);
  }
}

/** Report per-file module failures. The caller decides whether they are degradations (tools/schedules)
 *  or fatal (declared channels on the serving path). */
export function reportModuleLoadFailures(failures: ModuleLoadFailure[]): void {
  for (const f of failures) {
    log.warn(`[fastagent] ${f.label} failed to load, skipping it — ${f.message}`);
  }
}
