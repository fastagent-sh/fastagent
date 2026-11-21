/**
 * Built-in sandboxed coding tools (`read`, `write`, `edit`, `bash`) for `@fastagent-sh/harness-dsh`.
 * Filesystem tools enforce canonical `realpath` confinement to `workdir` and respect `read-only` mode;
 * `bash` confines every subprocess through `@deepseek-ai/dsh-sandbox` (`LocalSandboxProvider`), failing closed
 * when confinement is requested and unavailable.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type RunnerFailureRule,
  type SandboxProvider,
  classifyRunnerFailure,
  matchesSignature,
} from "@deepseek-ai/dsh-sandbox";
import { SessionId } from "@deepseek-ai/dsh-session";
import { resolveConfinedPath, toRuntimeSandboxPolicy } from "./sandbox.ts";
import type { DshCodingToolName, DshSandboxMode, FastAgentToolApi, FastAgentToolLike } from "./types.ts";

const ALL_CODING_TOOLS: readonly DshCodingToolName[] = ["read", "write", "edit", "bash"];
const CODING_TOOL_SET: ReadonlySet<string> = new Set(ALL_CODING_TOOLS);

export function resolveEnabledCodingTools(
  config: boolean | readonly DshCodingToolName[] | undefined,
): readonly DshCodingToolName[] {
  if (config === undefined || config === false) return [];
  if (config === true) return ALL_CODING_TOOLS;
  if (!Array.isArray(config)) {
    throw new Error("codingTools must be a boolean or an array of tool names");
  }
  const seen = new Set<DshCodingToolName>();
  const out: DshCodingToolName[] = [];
  for (const name of config) {
    if (!CODING_TOOL_SET.has(name)) {
      throw new Error(`Unknown coding tool "${String(name)}"; expected one of: ${ALL_CODING_TOOLS.join(", ")}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export interface CodingToolsContext {
  readonly workdir: string;
  readonly sandbox: DshSandboxMode;
  readonly getSandboxProvider: () => SandboxProvider | undefined;
}

function makeReadTool(workdir: string): FastAgentToolLike {
  return {
    name: "read",
    description: "Read a UTF-8 text file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "integer", minimum: 1, description: "1-indexed starting line number." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
      },
      required: ["path"],
    },
    execute: (async (args: { path: string; offset?: number; limit?: number }) => {
      try {
        const resolved = resolveConfinedPath(workdir, args.path);
        const content = readFileSync(resolved, "utf8");
        const lines = content.split(/\r?\n/);
        const start = args.offset !== undefined && args.offset > 1 ? args.offset - 1 : 0;
        const end = args.limit !== undefined && args.limit > 0 ? start + args.limit : lines.length;
        return { output: [{ type: "text", text: lines.slice(start, end).join("\n") }] };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }) as FastAgentToolLike["execute"],
  };
}

function makeWriteTool(workdir: string, sandbox: DshSandboxMode): FastAgentToolLike {
  return {
    name: "write",
    description: "Create or overwrite a UTF-8 text file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full file contents to write." },
      },
      required: ["path", "content"],
    },
    execute: (async (args: { path: string; content: string }) => {
      if (sandbox === "read-only") {
        return {
          isError: true,
          output: [{ type: "text", text: "Write denied: sandbox is in read-only mode" }],
        };
      }
      try {
        const resolved = resolveConfinedPath(workdir, args.path);
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, args.content, "utf8");
        return { output: [{ type: "text", text: `Wrote ${args.path}` }] };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }) as FastAgentToolLike["execute"],
  };
}

function makeEditTool(workdir: string, sandbox: DshSandboxMode): FastAgentToolLike {
  return {
    name: "edit",
    description: "Replace an exact unique substring in a file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        oldText: { type: "string", description: "Exact unique text to replace." },
        newText: { type: "string", description: "Replacement text." },
      },
      required: ["path", "oldText", "newText"],
    },
    execute: (async (args: { path: string; oldText: string; newText: string }) => {
      if (sandbox === "read-only") {
        return {
          isError: true,
          output: [{ type: "text", text: "Edit denied: sandbox is in read-only mode" }],
        };
      }
      try {
        const resolved = resolveConfinedPath(workdir, args.path);
        const current = readFileSync(resolved, "utf8");
        const first = current.indexOf(args.oldText);
        if (first === -1) {
          return { isError: true, output: [{ type: "text", text: `oldText not found in ${args.path}` }] };
        }
        if (current.indexOf(args.oldText, first + 1) !== -1) {
          return {
            isError: true,
            output: [{ type: "text", text: `oldText matched multiple locations in ${args.path}` }],
          };
        }
        const updated = current.slice(0, first) + args.newText + current.slice(first + args.oldText.length);
        writeFileSync(resolved, updated, "utf8");
        return { output: [{ type: "text", text: `Edited ${args.path}` }] };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }) as FastAgentToolLike["execute"],
  };
}

function makeBashTool(ctx: CodingToolsContext): FastAgentToolLike {
  return {
    name: "bash",
    description: "Execute a shell command confined to the workspace sandbox.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeoutMs: { type: "integer", minimum: 100, description: "Timeout in milliseconds (default: 30000)." },
      },
      required: ["command"],
    },
    execute: (async (
      args: { command: string; timeoutMs?: number },
      api: FastAgentToolApi,
      execCtx: { abortSignal?: AbortSignal; sessionId?: string },
    ) => {
      const rawArgv = ["/bin/sh", "-c", args.command];
      const runtimePolicy = toRuntimeSandboxPolicy({
        workdir: ctx.workdir,
        mode: ctx.sandbox,
        ...(execCtx.sessionId !== undefined ? { sessionId: SessionId(execCtx.sessionId) } : {}),
      });

      let spawnArgv = rawArgv;
      let denialSignatures: readonly string[] = [];
      let runnerFailureRules: readonly RunnerFailureRule[] = [];

      if (runtimePolicy !== undefined) {
        const provider = ctx.getSandboxProvider();
        if (provider === undefined) {
          return {
            isError: true,
            output: [{ type: "text", text: "SANDBOX_UNAVAILABLE: no OS sandbox provider is registered" }],
          };
        }
        try {
          const confined = await provider.confine(rawArgv, runtimePolicy, execCtx.abortSignal);
          spawnArgv = confined.argv;
          denialSignatures = confined.denialSignatures;
          runnerFailureRules = confined.runnerFailureRules;
        } catch (error) {
          return {
            isError: true,
            output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          };
        }
      }

      const [bin, ...binArgs] = spawnArgv;
      if (bin === undefined) {
        return { isError: true, output: [{ type: "text", text: "Empty command argv" }] };
      }

      const timeoutMs = args.timeoutMs ?? 30_000;
      return new Promise((resolve) => {
        const child = spawn(bin, binArgs, {
          cwd: ctx.workdir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const killChild = () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
        };

        const onAbort = () => killChild();
        execCtx.abortSignal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          killChild();
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdout += text;
          api.output?.(text);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr += text;
          api.output?.(text);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          execCtx.abortSignal?.removeEventListener("abort", onAbort);
          resolve({
            isError: true,
            output: [{ type: "text", text: error.message }],
          });
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          execCtx.abortSignal?.removeEventListener("abort", onAbort);
          const combined = [stdout, stderr]
            .filter((part) => part.length > 0)
            .join(stdout.endsWith("\n") || !stdout ? "" : "\n");
          if (timedOut) {
            resolve({
              isError: true,
              output: [{ type: "text", text: `Command timed out after ${timeoutMs}ms\n${combined}`.trim() }],
            });
            return;
          }
          if (code === 0) {
            resolve({
              output: [{ type: "text", text: combined }],
            });
            return;
          }
          const runnerDiag =
            runnerFailureRules.length > 0 ? classifyRunnerFailure(code, stderr, runnerFailureRules) : undefined;
          const sandboxDenied =
            runnerDiag === undefined && denialSignatures.length > 0 && matchesSignature(code, stderr, denialSignatures);
          const prefix =
            runnerDiag !== undefined
              ? `Sandbox runner failed (${runnerDiag.detail}): `
              : sandboxDenied
                ? "Sandbox denied file operation: "
                : `Command exited with ${code !== null ? `code ${code}` : `signal ${String(signal)}`}: `;
          resolve({
            isError: true,
            output: [{ type: "text", text: `${prefix}${combined}`.trim() }],
          });
        });
      });
    }) as FastAgentToolLike["execute"],
  };
}

/**
 * Build the enabled subset of built-in sandboxed coding tools.
 */
export function buildCodingTools(enabled: readonly DshCodingToolName[], ctx: CodingToolsContext): FastAgentToolLike[] {
  const tools: FastAgentToolLike[] = [];
  for (const name of enabled) {
    if (name === "read") tools.push(makeReadTool(ctx.workdir));
    else if (name === "write") tools.push(makeWriteTool(ctx.workdir, ctx.sandbox));
    else if (name === "edit") tools.push(makeEditTool(ctx.workdir, ctx.sandbox));
    else if (name === "bash") tools.push(makeBashTool(ctx));
  }
  return tools;
}
