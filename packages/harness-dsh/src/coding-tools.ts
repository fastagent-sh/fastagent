/**
 * Built-in sandboxed coding tools (`read`, `write`, `edit`, `bash`) for `@fastagent-sh/harness-dsh`.
 * Filesystem tools enforce canonical `realpath` confinement to `workdir` and respect `read-only` mode;
 * `bash` confines every subprocess through `@deepseek-ai/dsh-sandbox` (`LocalSandboxProvider`), failing closed
 * when confinement is requested and unavailable.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type RunnerFailureRule,
  type SandboxProvider,
  classifyRunnerFailure,
  matchesSignature,
} from "@deepseek-ai/dsh-sandbox";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { PortableTool } from "@fastagent-sh/fastagent/harness";
import { resolveConfinedPath, toRuntimeSandboxPolicy } from "./sandbox.ts";
import type { DshCodingToolName, DshSandboxMode, FastAgentToolApi } from "./types.ts";

const ALL_CODING_TOOLS: readonly DshCodingToolName[] = ["read", "write", "edit", "bash"];
const CODING_TOOL_SET: ReadonlySet<string> = new Set(ALL_CODING_TOOLS);
const MAX_READ_BYTES = 1024 * 1024;
const MAX_BASH_OUTPUT_BYTES = 256 * 1024;

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
  /** Canonical paths inside workdir that `write` and `edit` must never modify (e.g. `.fastagent`). */
  readonly protectedPaths?: readonly string[];
  /** Sanitized environment variables for `bash` child processes. */
  readonly env?: Readonly<Record<string, string>>;
}

function isProtectedPath(resolvedPath: string, protectedPaths: readonly string[] | undefined): boolean {
  if (protectedPaths === undefined || protectedPaths.length === 0) return false;
  for (const rawProtected of protectedPaths) {
    let canonical = resolve(rawProtected);
    try {
      canonical = realpathSync(rawProtected);
    } catch {
      // Directory may not exist yet; fall back to normalized absolute path.
    }
    const rel = relative(canonical, resolvedPath);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

function makeReadTool(workdir: string): PortableTool {
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
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          return { isError: true, output: [{ type: "text", text: `Cannot read directory: ${args.path}` }] };
        }
        if (stat.size > MAX_READ_BYTES) {
          return {
            isError: true,
            output: [{ type: "text", text: `File exceeds ${MAX_READ_BYTES} byte read limit: ${args.path}` }],
          };
        }
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
    }) as PortableTool["execute"],
  };
}

function makeWriteTool(workdir: string, sandbox: DshSandboxMode, protectedPaths?: readonly string[]): PortableTool {
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
        if (isProtectedPath(resolved, protectedPaths)) {
          return {
            isError: true,
            output: [{ type: "text", text: `Write denied: path is protected (${args.path})` }],
          };
        }
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, args.content, "utf8");
        return { output: [{ type: "text", text: `Wrote ${args.path}` }] };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }) as PortableTool["execute"],
  };
}

function makeEditTool(workdir: string, sandbox: DshSandboxMode, protectedPaths?: readonly string[]): PortableTool {
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
        if (isProtectedPath(resolved, protectedPaths)) {
          return {
            isError: true,
            output: [{ type: "text", text: `Edit denied: path is protected (${args.path})` }],
          };
        }
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
    }) as PortableTool["execute"],
  };
}

function makeBashTool(ctx: CodingToolsContext): PortableTool {
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
      if (typeof args.command !== "string" || args.command.trim().length === 0) {
        return { isError: true, output: [{ type: "text", text: "Command must be a non-empty string" }] };
      }
      const timeoutMs = args.timeoutMs ?? 30_000;
      if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return { isError: true, output: [{ type: "text", text: `Invalid timeoutMs: ${String(args.timeoutMs)}` }] };
      }
      if (execCtx.abortSignal?.aborted) {
        return { isError: true, output: [{ type: "text", text: "Command aborted before execution" }] };
      }
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

      if (execCtx.abortSignal?.aborted) {
        return { isError: true, output: [{ type: "text", text: "Command aborted before execution" }] };
      }
      return new Promise((resolvePromise) => {
        const detached = process.platform !== "win32";
        const child = spawn(bin, binArgs, {
          cwd: ctx.workdir,
          ...(ctx.env === undefined ? {} : { env: ctx.env }),
          stdio: ["ignore", "pipe", "pipe"],
          detached,
        });
        let stdout = "";
        let stderr = "";
        let totalBytes = 0;
        let truncated = false;
        let timedOut = false;

        const appendCapped = (current: string, text: string): string => {
          const bytes = Buffer.byteLength(text, "utf8");
          if (totalBytes + bytes <= MAX_BASH_OUTPUT_BYTES) {
            totalBytes += bytes;
            api.output?.(text);
            return current + text;
          }
          if (!truncated) {
            truncated = true;
            const remaining = Math.max(0, MAX_BASH_OUTPUT_BYTES - totalBytes);
            const partial = remaining > 0 ? Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8") : "";
            totalBytes = MAX_BASH_OUTPUT_BYTES;
            if (partial) api.output?.(partial);
            return `${current}${partial}\n[output truncated at ${MAX_BASH_OUTPUT_BYTES} bytes]`;
          }
          return current;
        };

        const killChild = () => {
          if (detached && child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
              return;
            } catch {
              // Fall back to direct child kill if process group already exited.
            }
          }
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
          stdout = appendCapped(stdout, chunk.toString("utf8"));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendCapped(stderr, chunk.toString("utf8"));
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          execCtx.abortSignal?.removeEventListener("abort", onAbort);
          resolvePromise({
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
            resolvePromise({
              isError: true,
              output: [{ type: "text", text: `Command timed out after ${timeoutMs}ms\n${combined}`.trim() }],
            });
            return;
          }
          if (code === 0) {
            resolvePromise({
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
          resolvePromise({
            isError: true,
            output: [{ type: "text", text: `${prefix}${combined}`.trim() }],
          });
        });
      });
    }) as PortableTool["execute"],
  };
}

/**
 * Build the enabled subset of built-in sandboxed coding tools.
 */
export function buildCodingTools(enabled: readonly DshCodingToolName[], ctx: CodingToolsContext): PortableTool[] {
  const tools: PortableTool[] = [];
  for (const name of enabled) {
    if (name === "read") tools.push(makeReadTool(ctx.workdir));
    else if (name === "write") tools.push(makeWriteTool(ctx.workdir, ctx.sandbox, ctx.protectedPaths));
    else if (name === "edit") tools.push(makeEditTool(ctx.workdir, ctx.sandbox, ctx.protectedPaths));
    else if (name === "bash") tools.push(makeBashTool(ctx));
  }
  return tools;
}
