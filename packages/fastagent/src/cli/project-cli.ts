/**
 * The CLI of the project the command runs in. An agent depends on a version of FastAgent, and that version's CLI is
 * the one to run it, so a `fastagent` installed elsewhere (globally) hands the command to the project's. Asked from
 * the working directory (after any leading `-C <dir>`), as Node resolves a package from there.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveFromProject } from "../runtime.ts";

const PACKAGE = "@fastagent-sh/fastagent";

/** The project's CLI entry when it is another installation than `ownRoot`'s, or undefined. */
export function projectCli(cwd: string, ownRoot: string): string | undefined {
  const manifest = resolveFromProject(cwd, `${PACKAGE}/package.json`);
  if (manifest === undefined) return undefined;
  const root = realpathSync(dirname(manifest));
  if (root === realpathSync(ownRoot)) return undefined;
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { fastagent?: string } };
  return bin?.fastagent === undefined ? undefined : join(root, bin.fastagent);
}
