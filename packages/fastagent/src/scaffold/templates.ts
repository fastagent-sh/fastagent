/**
 * Scaffold template ACCESS (data, not logic): readers for the real files `init` writes into an agent dir, plus the
 * parametric pieces.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Read a base agent template (src/scaffold/templates/<name>). */
export const baseTemplate = (name: string): string =>
  readFileSync(new URL(`./templates/${name}`, import.meta.url), "utf8");

export const DEFAULT_SCRIPTS = {
  dev: "fastagent dev",
  build: "fastagent build",
  start: "fastagent build && fastagent start",
} as const;

export function expectedManifestDeps(build: { version: string; typescript: string }): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  return {
    dependencies: { "@fastagent-sh/fastagent": `^${build.version}` },
    devDependencies: { typescript: build.typescript },
  };
}

/**
 * `package.json` for a scaffolded agent: `@fastagent-sh/fastagent` at this build's version and the TypeScript version
 * `fastagent build` compiles with.
 */
export function packageJson(name: string, build: { version: string; typescript: string }): string {
  const { dependencies, devDependencies } = expectedManifestDeps(build);
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: { ...DEFAULT_SCRIPTS },
      dependencies,
      devDependencies,
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
