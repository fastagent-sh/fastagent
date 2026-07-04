/**
 * Scaffold template ACCESS (data, not logic): readers for the real files `init`/`add` write into a
 * workspace, plus the parametric pieces. Base workspace templates live under ./templates/; each
 * channel's bundle lives WITH the channel at ../channels/<kind>/scaffold/ (so a channel owns its
 * starter kit and could ship as its own package). Both trees are excluded from this package's tsc +
 * biome (they import the published @kid7st/fastagent, not this source) and copied into dist/ by the build.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Read a base workspace template (src/scaffold/templates/<name>). */
export const baseTemplate = (name: string): string =>
  readFileSync(new URL(`./templates/${name}`, import.meta.url), "utf8");

const channelScaffoldDir = (kind: string): URL => new URL(`../channels/${kind}/scaffold/`, import.meta.url);

/** Read one file from a channel's scaffold bundle (src/channels/<kind>/scaffold/<name>). */
export const channelTemplate = (kind: string, name: string): string =>
  readFileSync(new URL(name, channelScaffoldDir(kind)), "utf8");

/** The .ts files in a channel's bundle: `channel.ts` is the channel adapter; the rest are companion tools. */
export const channelBundleFiles = (kind: string): string[] =>
  readdirSync(channelScaffoldDir(kind)).filter((f) => f.endsWith(".ts"));

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
