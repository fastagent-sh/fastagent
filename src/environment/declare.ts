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

/**
 * What `mise lock` writes beside the lock for a tool installed from a package registry (an npm tool's dependency
 * lock), and the lock names by path and digest: part of the lock, committed and shipped with it.
 */
export const MISE_LOCK_SIDECARS = ".mise/locks";

/** An agent's environment, as declared. */
export interface DeclaredEnvironment {
  /** The `mise.toml` it was read from. */
  path: string;
  /** The `[tools]` keys: tool names, with their backend prefix when written (`npm:prettier`). */
  tools: string[];
  /** The `[bootstrap.packages]` keys: `manager:package`. */
  packages: string[];
}

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

/**
 * What each backend installs with. mise takes these from the machine when `mise.toml` does not declare them, and does
 * not add them itself, so such a tool installs on an author's machine that has them and fails in the image. uv is
 * also what locks a Python tool's dependencies, and a locked Python install needs an installed interpreter.
 */
const TOOLCHAINS: Readonly<Record<string, readonly string[]>> = {
  pypi: ["python", "uv"],
  pipx: ["python", "uv"],
  cargo: ["rust"],
  go: ["go"],
  gem: ["ruby"],
};

/** Declared tools that need toolchains `mise.toml` does not declare, grouped by what is missing. */
export interface MissingToolchain {
  /** The tools, as declared. */
  tools: string[];
  /** The toolchains to declare. */
  missing: string[];
}

/**
 * The declared tools whose backend needs a toolchain `mise.toml` does not declare. Read from how a tool is written
 * (`pypi:markitdown`): a registry name mise resolves to one of these backends is not seen here, and fails the image
 * build instead.
 */
export function missingToolchains(environment: Pick<DeclaredEnvironment, "tools">): MissingToolchain[] {
  const groups = new Map<string, MissingToolchain>();
  for (const tool of environment.tools) {
    const backend = tool.includes(":") ? tool.slice(0, tool.indexOf(":")) : "";
    const missing = (TOOLCHAINS[backend] ?? []).filter((name) => !declaresTool(environment, name));
    if (missing.length === 0) continue;
    const group = groups.get(missing.join(" ")) ?? { tools: [], missing };
    group.tools.push(tool);
    groups.set(missing.join(" "), group);
  }
  return [...groups.values()];
}

/** What to tell whoever declared them, with the command that declares the rest. */
export function toolchainAdvice({ tools, missing }: MissingToolchain): string {
  const one = tools.length === 1;
  return (
    `${tools.join(", ")} ${one ? "installs" : "install"} with ${missing.join(" and ")}, which ${MISE_FILE} does not ` +
    `declare: mise then uses the machine's, and the image has none — run \`fastagent env use ${missing.join(" ")}\``
  );
}

/** Whether `mise.toml` declares `name` under any backend or owner: `aqua:astral-sh/uv` is `uv`. */
export function declaresTool(environment: Pick<DeclaredEnvironment, "tools">, name: string): boolean {
  return environment.tools.some((key) => toolName(key) === name);
}

function toolName(key: string): string {
  return (
    key
      .slice(key.indexOf(":") + 1)
      .split("/")
      .at(-1) ?? key
  );
}
