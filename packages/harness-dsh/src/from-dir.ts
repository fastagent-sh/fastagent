/**
 * Directory-based loader (`openDshAgentFromDir`) turning a standard FastAgent agent directory
 * (`SYSTEM.md`, `AGENTS.md`, `skills/<name>/SKILL.md`, `prompts/<name>.md`) into a live sandboxed DSH agent
 * without importing `@fastagent-sh/fastagent` or `@earendil-works/pi-durable`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef, ThinkingLevel } from "@fastagent-sh/client/agent-api";
import { openDshAgent } from "./agent.ts";
import { type SqliteDshEventStore, openSqliteDshStore } from "./sqlite-store.ts";
import type {
  DshAgent,
  DshCodingToolName,
  DshCommand,
  DshEventStoreBackend,
  DshRetryOptions,
  DshSandboxMode,
  DshTelemetryContext,
  FastAgentToolLike,
} from "./types.ts";

export interface DshFromDirOptions {
  /** Override the instance name (defaults to directory basename). */
  readonly name?: string;
  /** Override the workspace directory exposed to tools (defaults to `dir`). */
  readonly workdir?: string;
  /** Model registry supplying providers, auth, and streaming. */
  readonly models?: Models;
  /** Default model selection (`provider` + `modelId`). */
  readonly model?: ModelRef;
  readonly thinkingLevel?: ThinkingLevel;
  /** Additional portable FastAgent tools (`defineTool`). */
  readonly tools?: readonly FastAgentToolLike[];
  /** Built-in sandboxed coding tools. Default: `true` (`read`, `write`, `edit`, `bash`). */
  readonly codingTools?: boolean | readonly DshCodingToolName[];
  /** OS sandbox posture. Default: `"workspace"`. */
  readonly sandbox?: DshSandboxMode;
  /** Sanitized environment variables passed to sandboxed shell commands. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional telemetry context for exporting content-free model and tool run spans. */
  readonly telemetry?: DshTelemetryContext;
  readonly retry?: DshRetryOptions;
  /** Custom storage backend. Defaults to SQLite at `<dir>/.fastagent/dsh.sqlite`. */
  readonly storage?: DshEventStoreBackend;
}

interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

function readOptionalText(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

function parseFrontmatter(content: string): { readonly meta: Record<string, string>; readonly body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) return { meta: {}, body: content.trim() };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    const val = rawVal.replace(/^["']|["']$/g, "");
    if (key.length > 0) meta[key] = val;
  }
  return { meta, body: (match[2] ?? "").trim() };
}

function loadSkills(dir: string): ParsedSkill[] {
  const skillsDir = join(dir, "skills");
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
  const skills: ParsedSkill[] = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const skillFile = join(skillsDir, entry, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const { meta } = parseFrontmatter(readFileSync(skillFile, "utf8"));
    skills.push({
      name: meta.name || entry,
      description: meta.description || "",
      path: `skills/${entry}/SKILL.md`,
    });
  }
  return skills;
}

function loadPromptCommands(dir: string): DshCommand[] {
  const promptsDir = join(dir, "prompts");
  if (!existsSync(promptsDir) || !statSync(promptsDir).isDirectory()) return [];
  const commands: DshCommand[] = [];
  for (const file of readdirSync(promptsDir).sort()) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    const { meta, body } = parseFrontmatter(readFileSync(join(promptsDir, file), "utf8"));
    commands.push({
      name,
      ...(meta.description ? { description: meta.description } : {}),
      expand(args: string): string {
        if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
        return args.trim().length > 0 ? `${body}\n\n${args}` : body;
      },
    });
  }
  return commands;
}

function assembleSystemPrompt(dir: string): string | undefined {
  const parts: string[] = [];
  const systemMd = readOptionalText(join(dir, "SYSTEM.md"));
  if (systemMd !== undefined) parts.push(systemMd);
  const agentsMd = readOptionalText(join(dir, "AGENTS.md"));
  if (agentsMd !== undefined) parts.push(agentsMd);
  const skills = loadSkills(dir);
  if (skills.length > 0) {
    const lines = skills.map((s) => `- **${s.name}** (\`${s.path}\`)${s.description ? `: ${s.description}` : ""}`);
    parts.push(`## Available Skills\n\n${lines.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Open a FastAgent directory (`SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`) on the DSH harness
 * with OS sandboxing (`"workspace"` by default) and SQLite persistence (`.fastagent/dsh.sqlite`).
 * @public
 */
export async function openDshAgentFromDir(dir: string, options: DshFromDirOptions = {}): Promise<DshAgent> {
  const absDir = isAbsolute(dir) ? dir : resolve(dir);
  const workdir = options.workdir ?? absDir;
  const name = options.name ?? basename(absDir);
  const systemPrompt = assembleSystemPrompt(absDir);
  const commands = loadPromptCommands(absDir);

  let ownedSqlite: SqliteDshEventStore | undefined;
  let storage: DshEventStoreBackend;
  if (options.storage !== undefined) {
    storage = options.storage;
  } else {
    ownedSqlite = openSqliteDshStore(join(absDir, ".fastagent", "dsh.sqlite"));
    storage = ownedSqlite;
  }

  try {
    const agent = await openDshAgent({
      name,
      workdir,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(options.models !== undefined ? { models: options.models } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      codingTools: options.codingTools ?? true,
      protectedPaths: [join(absDir, ".fastagent")],
      ...(options.env !== undefined ? { env: options.env } : {}),
      sandbox: options.sandbox ?? "workspace",
      ...(commands.length > 0 ? { commands: () => commands } : {}),
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
      ...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
      storage,
    });
    if (ownedSqlite === undefined) return agent;
    const sqlite = ownedSqlite;
    return {
      ...agent,
      async close() {
        try {
          await agent.close();
        } finally {
          await sqlite.close();
        }
      },
    };
  } catch (error) {
    await ownedSqlite?.close().catch(() => {});
    throw error;
  }
}
