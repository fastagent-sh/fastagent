/**
 * Scaffold template content (data, not logic): the files `init` and `add` write into a workspace.
 * The content lives as REAL files under templates/, read at scaffold time — so template code is real
 * code (no backtick/backslash escaping, real highlighting, editable as a file). templates/ is excluded
 * from this package's tsc + biome (it imports the published @kid7st/fastagent, not this source) and is
 * copied into dist/ by the build's postbuild step. Only the parametric pieces (the AGENTS.md tool line,
 * package.json, the package-name helper) stay here as code.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const read = (name: string): string => readFileSync(new URL(`./templates/${name}`, import.meta.url), "utf8");

/** Identity persona (clean — it is the system prompt). The complete variant references the tool. */
export function agentsMd(minimal: boolean): string {
  const toolLine = minimal ? "" : "\nWhen the user asks how long a piece of text is, use the word-count tool.\n";
  return read("AGENTS.md") + toolLine;
}

export const SKILL_MD = read("house-style.md");
export const TOOL_TS = read("tool.ts");
export const CONFIG_MJS = read("fastagent.config.mjs");
export const GITIGNORE = read("gitignore");
export const ENV_EXAMPLE = read("env.example");
export const CHANNEL_GITHUB_TS = read("channels/github.ts");
export const CHANNEL_TELEGRAM_TS = read("channels/telegram.ts");
export const TELEGRAM_SEND_TOOL_TS = read("tools/telegram-send.ts");

/** package.json for the complete agent: ESM + the deps a defineTool tool imports. The
 *  @kid7st/fastagent range tracks THIS build's version, so a fresh workspace installs an API-matching version. */
export function packageJson(name: string, version: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      dependencies: { "@kid7st/fastagent": `^${version}`, zod: "^4.0.0" },
    },
    null,
    2,
  )}\n`;
}

/** Sanitize a directory basename into a valid npm package name (lowercase, safe chars). */
export function toPackageName(dir: string): string {
  const base = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "");
  return base || "agent";
}
