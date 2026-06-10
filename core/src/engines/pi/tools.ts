/**
 * Default toolset for the pi engine = pi's real built-in core coding tools
 * (read/bash/edit/write, same as pi's default).
 *
 * Stance (flipped once after scenario-driven re-derivation, now final):
 *   - **Full default toolset = fidelity**: definition authors vibe in local pi with the
 *     full toolset; serving with fewer tools = behavior drift (same logic as the base
 *     prompt). We use pi-coding-agent's factories so tool names/descriptions/behavior
 *     match local pi verbatim.
 *   - **The tool layer is not the security boundary**: isolation is the K-side
 *     ExecutionEnv/sandbox's job (local = the user's own machine; AgentCore = microVM).
 *     Locking down for public exposure = explicitly passing `tools` (e.g.
 *     createReadOnlyTools) — a deployment posture, not the default.
 *   - pi tools take injectable operations (BashOperations etc.); a future sandbox
 *     adapter swaps operations rather than being locked to local fs.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";

/** pi's core default toolset (read/bash/edit/write, matching pi defaults), rooted at cwd. */
export function piDefaultTools(cwd: string): AgentTool[] {
  return createCodingTools(cwd) as AgentTool[];
}

/** Read-only subset (read/grep/find/ls) for locked-down postures such as public exposure. */
export function piReadOnlyTools(cwd: string): AgentTool[] {
  return createReadOnlyTools(cwd) as AgentTool[];
}
