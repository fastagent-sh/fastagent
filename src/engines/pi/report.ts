/**
 * Render assembly warnings to stderr — the one place both the CLI runners and the `chat` runtime show
 * the non-fatal definition/tool findings the loaders return as data. One copy so the wording can't drift.
 */
import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { log } from "../../log.ts";
import type { SkillCollision } from "./definition.ts";
import type { ModuleLoadFailure } from "../../loader.ts";
import type { ToolCollision } from "./tool.ts";

type Findings = { collisions: SkillCollision[]; diagnostics: SkillDiagnostic[] };

/** Stable identity of a definition's non-fatal findings — the dedup key below. */
function findingsSignature(def: Findings): string {
  const collisions = def.collisions.map((c) => `c:${c.name}:${c.winnerPath}:${c.loserPath}`);
  const diagnostics = def.diagnostics.map((d) => `d:${d.code}:${d.path}`);
  return [...collisions, ...diagnostics].sort().join("\n");
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
 */
export function reportFindingsIfChanged(dir: string, def: Findings): void {
  const sig = findingsSignature(def);
  if (lastFindings.get(dir) === sig) return;
  lastFindings.set(dir, sig);
  reportDefinitionWarnings(def.collisions, def.diagnostics);
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
