/**
 * Experimental entry point for opening a FastAgent instance over DeepSeek Harness (`@deepseek-ai/dsh`).
 * Phase 0 skeleton: validates options, sandbox posture, and bridged tool definitions up front, and refuses clearly
 * until Phase 1 wires the live Cordis `AgentLoop` runtime.
 */
import { isAbsolute } from "node:path";
import { AgentError } from "@fastagent-sh/client";
import { buildDshSandboxPolicy } from "./sandbox.ts";
import { toDshToolDefinition } from "./tools.ts";
import type { DshAgent, DshHarnessOptions } from "./types.ts";

/**
 * Open a FastAgent instance on the experimental DSH harness.
 * Validates `workdir`, `sandbox` policy, and bridged `tools` fail-fast before attempting runtime boot.
 * @public
 */
export async function openDshAgent(options: DshHarnessOptions): Promise<DshAgent> {
  if (!options.name || options.name.trim() === "") {
    throw new AgentError({ code: "invalid_request", message: "DSH agent name must be non-empty", retryable: false });
  }
  if (!isAbsolute(options.workdir)) {
    throw new AgentError({
      code: "invalid_request",
      message: `DSH workdir must be an absolute path, got ${JSON.stringify(options.workdir)}`,
      retryable: false,
    });
  }
  // Validate sandbox policy and tool bridges eagerly so authoring errors surface immediately.
  buildDshSandboxPolicy({
    workdir: options.workdir,
    ...(options.sandbox === undefined ? {} : { mode: options.sandbox }),
    ...(options.sandboxNetwork === undefined ? {} : { network: options.sandboxNetwork }),
  });
  for (const tool of options.tools ?? []) {
    toDshToolDefinition(tool);
  }
  throw new AgentError({
    code: "unavailable",
    message:
      "@fastagent-sh/harness-dsh is a Phase 0 skeleton: live Cordis AgentLoop execution is tracked in packages/harness-dsh/DESIGN.md (Phase 1)",
    retryable: false,
  });
}
