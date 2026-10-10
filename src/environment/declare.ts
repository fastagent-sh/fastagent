/**
 * WHAT AN AGENT'S ENVIRONMENT IS: the part of its `mise.toml` FastAgent supports, read and refused in ONE place. mise's
 * format, FastAgent's contract: `[tools]` (CLIs and runtimes, locked, the same on every platform) and
 * `[bootstrap.packages]` (system packages for what has no cross-platform build, installed in the image). Everything
 * else mise reads there would run differently, or not at all, where the agent is deployed, so it is refused by name.
 * docs/design/agent-service.md §4 is the rule.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";

/** The agent's environment declaration. */
export const MISE_FILE = "mise.toml";

/** What `deploy` writes beside it: each tool's download URL and checksum, per platform the image is built for. */
export const MISE_LOCK_FILE = "mise.lock";

/** An agent's environment, as declared. */
export interface DeclaredEnvironment {
  /** The `mise.toml` it was read from. */
  path: string;
  /** The `[tools]` keys: tool names, with their backend prefix when written (`npm:prettier`). */
  tools: string[];
  /** The `[bootstrap.packages]` keys: `manager:package`. */
  packages: string[];
}

/** Backends that install by running a plugin's code, and whose installs mise cannot lock. */
const PLUGIN_BACKEND = /^(asdf|vfox):/;

/** The agent's environment, or undefined when it has no `mise.toml` (it borrows the machine's commands). */
export function readEnvironment(agentDir: string): DeclaredEnvironment | undefined {
  const path = join(resolve(agentDir), MISE_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let raw: Record<string, unknown>;
  try {
    raw = parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid TOML: ${(error as Error).message}`);
  }
  for (const key of Object.keys(raw)) {
    if (key === "tools" || key === "bootstrap") continue;
    if (key === "env") {
      throw new Error(`${path}: [env] is not supported yet — set environment variables in .secrets/.env`);
    }
    throw new Error(
      `${path}: "${key}" is not supported — an agent's mise.toml declares [tools] and [bootstrap.packages] only, ` +
        `because the rest of mise (tasks, hooks, settings, plugins…) would run differently, or not at all, where ` +
        `the agent is deployed`,
    );
  }
  const tools = table(raw.tools, "[tools]", path);
  for (const [name, value] of Object.entries(tools)) {
    if (PLUGIN_BACKEND.test(name)) {
      throw new Error(
        `${path}: tool "${name}" installs through a plugin, which mise cannot lock — use another backend`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value) && "postinstall" in value) {
      throw new Error(`${path}: tool "${name}" has a postinstall command — an install must not run code`);
    }
  }
  const bootstrap = table(raw.bootstrap, "[bootstrap]", path);
  for (const key of Object.keys(bootstrap)) {
    if (key !== "packages") {
      throw new Error(
        `${path}: [bootstrap.${key}] is not supported — only [bootstrap.packages], the system packages the image ` +
          `installs, belongs to an agent's environment`,
      );
    }
  }
  const packages = table(bootstrap.packages, "[bootstrap.packages]", path);
  return { path, tools: Object.keys(tools), packages: Object.keys(packages) };
}

function table(value: unknown, what: string, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: ${what} must be a table`);
  return value as Record<string, unknown>;
}
