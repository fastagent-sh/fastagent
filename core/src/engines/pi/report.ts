/**
 * Render assembly warnings to stderr — the one place both the CLI runners and the `chat` runtime show
 * the non-fatal definition/tool findings the loaders return as data. One copy so the wording can't drift.
 */
import type { SkillDiagnostic } from "@earendil-works/pi-agent-core";
import type { SkillCollision } from "./definition.ts";
import type { ToolCollision } from "./tool.ts";

export function reportDefinitionWarnings(collisions: SkillCollision[], diagnostics: SkillDiagnostic[]): void {
  for (const c of collisions) {
    console.error(`[fastagent] warn: skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
  }
  for (const d of diagnostics) {
    console.error(`[fastagent] warn: ${d.code}: ${d.message} (${d.path})`);
  }
}

export function reportToolCollisions(collisions: ToolCollision[]): void {
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) dropped — a default/config tool already uses that name`,
    );
  }
}
