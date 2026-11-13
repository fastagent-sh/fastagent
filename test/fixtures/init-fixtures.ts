import { withGitIdentity } from "../doubles/git-env.ts";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInProcess } from "../doubles/cli-run.ts";

export const freshDir = () => mkdtemp(join(tmpdir(), "fa-init-"));

export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

export const withIdentity = withGitIdentity;

/** Run `fastagent <args>` from `cwd` to completion; return stderr (the [fastagent] report stream). */
export async function cliInit(args: string[], cwd: string, env: NodeJS.ProcessEnv = withIdentity): Promise<string> {
  return (await runInProcess(args, cwd, env)).stderr;
}
