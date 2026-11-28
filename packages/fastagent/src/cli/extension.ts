/**
 * A command an installed extension adds: `fastagent <name> …` runs the `./cli` entry of `@fastagent-sh/<name>`, as git
 * runs `git-<name>`. It is resolved from the working directory, as Node resolves a package, so the agent's own
 * installation decides which version runs, as for the CLI itself (project-cli.ts). Only the `@fastagent-sh` scope: a
 * command name never runs a package someone else published.
 */
import { pathToFileURL } from "node:url";
import { resolveFromProject } from "../runtime.ts";

/** What an extension's `./cli` entry exports: its commands, given the arguments after its name. */
export interface ExtensionCli {
  run(args: readonly string[]): Promise<void>;
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** The package that would add `fastagent <name>`. */
export const extensionPackage = (name: string): string => `@fastagent-sh/${name}`;

/** The `./cli` entry of the extension `name` installed where `cwd` resolves packages, or undefined. */
export function extensionEntry(cwd: string, name: string): string | undefined {
  if (!NAME.test(name)) return undefined;
  return resolveFromProject(cwd, `${extensionPackage(name)}/cli`);
}

export async function runExtension(entry: string, args: readonly string[]): Promise<void> {
  const cli = (await import(pathToFileURL(entry).href)) as Partial<ExtensionCli>;
  if (typeof cli.run !== "function") throw new Error(`${entry} exports no run(args): it is not a fastagent extension`);
  await cli.run(args);
}
