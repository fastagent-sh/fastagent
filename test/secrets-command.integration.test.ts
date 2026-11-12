import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { run } from "./cli-run.ts";
import { agent } from "./secrets-command-fixtures.ts";

/** A `fly` that prints on its stdout whatever it does: what it says is the host CLI's, never the command's result. */
async function talkativeFly(): Promise<NodeJS.ProcessEnv> {
  const bin = await mkdtemp(join(tmpdir(), "fa-fake-fly-"));
  await writeFile(
    join(bin, "fly"),
    `#!/bin/sh
case "$1 $2" in
  "apps list") echo '[]';;
  "apps create") echo "New app created";;
  "secrets set") cat > /dev/null; echo "Secrets are staged";;
esac
`,
  );
  await chmod(join(bin, "fly"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

it("--generate's stdout is the key and nothing else, whatever the host CLI prints", async () => {
  const env = await talkativeFly();
  const dir = await agent();
  // A real process, since what is under test is where a child's stdout goes.
  const result = await run(["secrets", "set", "fly", "FASTAGENT_API_KEY", dir, "--generate"], undefined, env);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^[\w-]{43}\n$/);
  // The host CLI's own lines are still said, on stderr.
  expect(result.stderr).toContain("New app created");
  expect(result.stderr).toContain("Secrets are staged");
}, 30_000);
