/**
 * Scaffold template ACCESS (data, not logic): readers for the real files `init`/`add` write into an agent dir, plus
 * the parametric pieces.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Read a base agent template (src/scaffold/templates/<name>). */
export const baseTemplate = (name: string): string =>
  readFileSync(new URL(`./templates/${name}`, import.meta.url), "utf8");

const channelScaffoldDir = (kind: string): URL => new URL(`../channels/${kind}/scaffold/`, import.meta.url);

/** Read one file from a channel's scaffold bundle (src/channels/<kind>/scaffold/<name>). */
export const channelTemplate = (kind: string, name: string): string =>
  readFileSync(new URL(name, channelScaffoldDir(kind)), "utf8");

/** The .ts files in a channel's bundle: `channel.ts` is the channel adapter; the rest are companion tools. */
export const channelBundleFiles = (kind: string): string[] =>
  readdirSync(channelScaffoldDir(kind)).filter((f) => f.endsWith(".ts"));

/** package.json for the complete agent. */
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
