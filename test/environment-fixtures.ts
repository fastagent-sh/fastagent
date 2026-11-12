import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const savedEnv = { ...process.env };

export const FASTAGENT = { "@fastagent-sh/fastagent": "^0.24.4" };

export async function agentDir(environment?: unknown): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fa-env-")));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "a", private: true, dependencies: FASTAGENT }));
  if (environment !== undefined) await writeFile(join(dir, "context.json"), JSON.stringify({ environment }));
  return dir;
}

/** A stand-in npm, for PATH: it records what it was asked and installs this platform's mise package, as npm does. */
export async function fakeNpm(dir: string): Promise<string> {
  const fakeBin = await realpath(await mkdtemp(join(tmpdir(), "fa-env-npm-")));
  const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
  await writeFile(
    join(fakeBin, "npm"),
    `#!/bin/sh\necho "$*" > "${join(dir, "npm-args")}"\nmkdir -p "${pkg}/bin" && echo '{}' > "${pkg}/package.json" && : > "${pkg}/bin/mise"\n`,
  );
  await chmod(join(fakeBin, "npm"), 0o755);
  return fakeBin;
}
