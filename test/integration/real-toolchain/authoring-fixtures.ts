import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withGitIdentity } from "../../doubles/git-env.ts";

const SRC = fileURLToPath(new URL("../../../packages/fastagent/src", import.meta.url));

/**
 * Scaffold an agent and open it in a plain Node process. vitest aliases `@fastagent-sh/fastagent` to this checkout's
 * source, which would make every import resolve; a child process run from a temp directory resolves it the way an
 * app that never ran `npm install` there does: not at all.
 */
export function createAndOpen(dir: string): Promise<string> {
  const script = `
    import { scaffoldAgent } from ${JSON.stringify(join(SRC, "scaffold/init.ts"))};
    import { loadSourceDefinition } from ${JSON.stringify(join(SRC, "harnesses/pi-durable/open.ts"))};
    import { openServing } from ${JSON.stringify(join(SRC, "harnesses/serving.ts"))};
    await scaffoldAgent(${JSON.stringify(dir)});
    await loadSourceDefinition(${JSON.stringify(dir)}).then((definition) => openServing(definition, { secrets: {}, env: {}, ownEnv: process.env, runsAs: { dev: false, deployed: false }, storage: "memory" })).then(
      async (opened) => {
        await opened.agent.close();
        console.log("opened");
      },
      (e) => console.log(e.message),
    );
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmpdir(),
      env: withGitIdentity,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    // The script reports the open's outcome on stdout and exits 0; anything else failed before it got there.
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}:\n${err}`)),
    );
  });
}
