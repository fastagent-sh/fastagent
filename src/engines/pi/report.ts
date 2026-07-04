/**
 * Render assembly warnings to stderr — the one place both the CLI runners and the `chat` runtime show
 * the non-fatal definition/tool findings the loaders return as data. One copy so the wording can't drift.
 */
import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { log } from "../../log.ts";
import type { SkillCollision } from "./definition.ts";
import type { ToolCollision } from "./tool.ts";

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
