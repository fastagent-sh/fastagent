/**
 * Render assembly warnings to stderr — the one place both the CLI runners and the `chat` runtime show the non-fatal
 * definition/tool findings the loaders return as data.
 */
import { relative } from "node:path";
import { log } from "../../log.ts";
import type { DefinitionDiagnostic, DefinitionShadow, LoadedDefinition, SkillCollision } from "./definition.ts";
import type { ToolCollision } from "./tool.ts";
import type { IndirectTool, ToolReach } from "./create.ts";

type Findings = {
  collisions: SkillCollision[];
  diagnostics: DefinitionDiagnostic[];
  shadowed?: DefinitionShadow[];
  ignored?: LoadedDefinition["ignored"];
};

/** Stable identity of a definition's non-fatal findings — the dedup key below. */
function findingsSignature(def: Findings): string {
  const collisions = def.collisions.map((c) => `c:${c.name}:${c.winnerPath}:${c.loserPath}`);
  const diagnostics = def.diagnostics.map((d) => `d:${d.code}:${d.path}`);
  const shadowed = (def.shadowed ?? []).map((s) => `s:${s.what}:${s.winnerPath}:${s.loserPath}`);
  const ignored = (def.ignored ?? []).map((i) => `i:${i.path}`);
  return [...collisions, ...diagnostics, ...shadowed, ...ignored].sort().join("\n");
}

/** The last reported finding set PER DEFINITION DIR. */
const lastFindings = new Map<string, string>();

/** THE door for definition findings: warns only when this dir's set CHANGED since the last report. */
export function reportFindingsIfChanged(dir: string, def: Findings): void {
  const sig = findingsSignature(def);
  if (lastFindings.get(dir) === sig) return;
  lastFindings.set(dir, sig);
  reportDefinitionWarnings(def);
}

export function reportDefinitionWarnings(def: Findings): void {
  for (const c of def.collisions) {
    log.warn(`[fastagent] skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
  }
  for (const s of def.shadowed ?? []) {
    log.warn(`[fastagent] ${s.what} is in two places — using ${s.winnerPath}, ignoring ${s.loserPath}`);
  }
  for (const i of def.ignored ?? []) {
    log.warn(`[fastagent] ${i.path} is ${i.reason}`);
  }
  for (const d of def.diagnostics) {
    log.warn(`[fastagent] ${d.code}: ${d.message} (${d.path})`);
  }
}

/** What the agent's system prompt is made of, as a report line: pi's default or `SYSTEM.md`, plus an addendum. */
export function describePrompt(def: Pick<LoadedDefinition, "dir" | "systemPrompt" | "appendSystemPrompt">): string {
  const base = def.systemPrompt ? relative(def.dir, def.systemPrompt.path) : "pi's default";
  return def.appendSystemPrompt ? `${base} + ${relative(def.dir, def.appendSystemPrompt.path)}` : base;
}

const REACH: Record<ToolReach, string> = {
  tool_search: "loaded via tool_search",
  codemode: "codemode scripts only",
  hidden: "hidden",
  inactive: "inactive until an authored loader activates it",
  unreachable: "unreachable: pi's settings disable the built-in extension it needs",
};

/** The report line for the mounted tools the model is not given up front: each name with its way in. */
export function describeIndirectTools(tools: readonly IndirectTool[]): string {
  return tools.map((tool) => `${tool.name} (${REACH[tool.reach]})`).join(", ");
}

export function reportToolCollisions(collisions: ToolCollision[]): void {
  for (const c of collisions) {
    log.warn(`[fastagent] tool "${c.name}" (${c.source}) dropped — a default/config tool already uses that name`);
  }
}
