/**
 * The CLI of the project the command runs in. An agent depends on a version of FastAgent, and that version's CLI is
 * the one to run it, so a `fastagent` installed elsewhere (globally) hands the command to the project's. Asked from
 * the working directory (after any leading `-C <dir>`), as Node resolves a package from there.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PACKAGE = "@fastagent-sh/fastagent";

/** The project's CLI entry when it is another installation than `ownRoot`'s, or undefined. */
export function projectCli(cwd: string, ownRoot: string): string | undefined {
  let manifest: string;
  try {
    manifest = createRequire(join(cwd, "package.json")).resolve(`${PACKAGE}/package.json`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No installation here, or one that is not a FastAgent package (it exports no manifest).
    if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return undefined;
    throw error;
  }
  const root = realpathSync(dirname(manifest));
  if (root === realpathSync(ownRoot)) return undefined;
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: { fastagent?: string } };
  return bin?.fastagent === undefined ? undefined : join(root, bin.fastagent);
}
