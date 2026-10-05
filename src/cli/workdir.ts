/** Making the directory `--workdir` names, for `init` and `context add`, which both make it only after every check. */
import { mkdir, rmdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Make `path` when it is missing (`--workdir` on a folder that does not exist yet gives an agent a folder of its own).
 * `undo` removes what this call made, deepest first and only while empty, so a later failing step leaves nothing of
 * it behind and never takes anything else with it.
 */
export async function makeWorkingDirectory(path: string): Promise<{ created: boolean; undo(): Promise<void> }> {
  // The first directory mkdir made, the top of the chain; undefined when `path` already existed.
  const top = await mkdir(path, { recursive: true });
  const chain: string[] = [];
  if (top !== undefined) for (let dir = path; ; dir = dirname(dir)) if (chain.push(dir) && dir === top) break;
  return {
    created: top !== undefined,
    async undo() {
      for (const dir of chain) {
        // Reported, not thrown: this runs on a failure path, and the failure being reported is the one that matters.
        await rmdir(dir).catch((error: unknown) =>
          console.error(
            `[fastagent] warn: could not remove ${dir}, which this command made: ${(error as Error).message}`,
          ),
        );
      }
    },
  };
}
