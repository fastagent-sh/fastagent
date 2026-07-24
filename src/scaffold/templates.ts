/**
 * Scaffold template ACCESS (data, not logic): readers for the real files `init`/`add` write into a
 * workspace, plus the parametric pieces. Base workspace templates live under ./templates/; each
 * channel's bundle lives WITH the channel at ../channels/<kind>/scaffold/ (so a channel owns its
 * starter kit and could ship as its own package). Both trees are excluded from this package's tsc +
 * biome (they import the published @fastagent-sh/fastagent, not this source) and copied into dist/ by the build.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Read a base workspace template (src/scaffold/templates/<name>). */
export const baseTemplate = (name: string): string =>
  readFileSync(new URL(`./templates/${name}`, import.meta.url), "utf8");

/** The persona template; in the embedded layout a locator note is appended (anchor-free — no
 *  silent-miss risk) so the self-iteration guidance ("write skills beside this file") points into the
 *  `.fastagent/` workspace — a skill written to the host root's `skills/` would never be scanned. */
export function personaTemplate(embedded = false): string {
  const base = baseTemplate("persona.md");
  if (!embedded) return base;
  return `${base}\nNote: your whole definition lives in \`.fastagent/\` at the workspace root — this file is \`.fastagent/persona.md\`, and a new skill goes to \`.fastagent/skills/<name>/SKILL.md\` (a \`skills/\` outside \`.fastagent/\` is not scanned). Everything OUTSIDE \`.fastagent/\` is the project you work on, not your definition.\n`;
}

const channelScaffoldDir = (kind: string): URL => new URL(`../channels/${kind}/scaffold/`, import.meta.url);

/** Read one file from a channel's scaffold bundle (src/channels/<kind>/scaffold/<name>). */
export const channelTemplate = (kind: string, name: string): string =>
  readFileSync(new URL(name, channelScaffoldDir(kind)), "utf8");

/** The .ts files in a channel's bundle: `channel.ts` is the channel adapter; the rest are companion tools. */
export const channelBundleFiles = (kind: string): string[] =>
  readdirSync(channelScaffoldDir(kind)).filter((f) => f.endsWith(".ts"));

/** package.json for the complete agent. The @fastagent-sh/fastagent range tracks THIS build's
 *  version, and tool authors use its `z` re-export rather than installing a second zod copy. */
export function packageJson(name: string, version: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      dependencies: { "@fastagent-sh/fastagent": `^${version}` },
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
