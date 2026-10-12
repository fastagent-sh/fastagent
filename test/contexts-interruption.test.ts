import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { fetchContexts } from "../src/contexts/fetch.ts";
import { isUnderDir } from "../src/paths.ts";
import { githubStandIn } from "./github-standin.ts";

let root = "";
let abandoned = "";
afterEach(async () => {
  vi.unstubAllEnvs();
  if (abandoned) await rm(abandoned, { recursive: true, force: true });
  if (root) await rm(root, { recursive: true, force: true });
});

it("refuses a TMPDIR inside the agent before fetching anything into the build context", async () => {
  const github = githubStandIn();
  github.repo("acme/context").commit({ "context.json": "{}" });
  root = await mkdtemp(join(tmpdir(), "fa-ctx-tmpdir-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "context.json"), JSON.stringify({ contexts: { acme: { github: "acme/context" } } }));
  vi.stubEnv("TMPDIR", agent);
  await expect(fetchContexts(agent, [{ name: "acme", repo: "acme/context" }], "fail")).rejects.toThrow(
    /temporary context clones must be outside.*set TMPDIR/,
  );
  expect((await readdir(agent)).filter((entry) => entry.startsWith("fastagent-context-"))).toEqual([]);
});

it("a process killed after fetching leaves its repository outside the build context, and retry ships only declarations", async () => {
  const github = githubStandIn();
  github.repo("acme/context").commit({ "context.json": "{}", "secret.txt": "must not ship" });
  root = await realpath(await mkdtemp(join(tmpdir(), "fa-ctx-interrupt-")));
  const agent = join(root, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "context.json"), JSON.stringify({ contexts: { acme: { github: "acme/context" } } }));
  const contexts = [{ name: "acme", repo: "acme/context" }];
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  await mkdir(bin);
  const stageFile = join(root, "stage");
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
"${realGit}" "$@"
code=$?
if [ "$code" = 0 ]; then
  for arg in "$@"; do
    if [ "$arg" = fetch ]; then
      printf '%s' "$PWD" > "${stageFile}"
      while :; do sleep 1; done
    fi
  done
fi
exit "$code"
`,
  );
  await chmod(join(bin, "git"), 0o755);
  const module = fileURLToPath(new URL("../src/contexts/fetch.ts", import.meta.url));
  const script = `import { fetchContexts } from ${JSON.stringify(module)};
    await fetchContexts(${JSON.stringify(agent)}, ${JSON.stringify(contexts)}, "fail", true);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    detached: true,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const stopped = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  try {
    await vi.waitFor(
      () => {
        expect(child.exitCode, stderr).toBeNull();
        expect(existsSync(stageFile)).toBe(true);
      },
      { timeout: 10000 },
    );
    abandoned = await readFile(stageFile, "utf8");
  } finally {
    if (child.signalCode === null && child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
    await stopped;
  }
  expect(isUnderDir(abandoned, agent)).toBe(false);
  // A snapshot is fetched, never checked out: what a kill leaves behind is an object store, not the repository's files.
  expect(existsSync(join(abandoned, ".git"))).toBe(true);
  expect(existsSync(join(abandoned, "secret.txt"))).toBe(false);
  // These lock owners were killed, rather than timed out; clearing their locks makes retry deterministic.
  await rm(join(agent, "context.json.lock"), { recursive: true, force: true });
  await rm(join(agent, ".contexts", "acme.lock"), { recursive: true, force: true });
  await fetchContexts(agent, contexts, "fail", true);
  expect(await readdir(join(agent, ".contexts"))).toEqual(["acme"]);
  expect((await readdir(join(agent, ".contexts", "acme"))).sort()).toEqual([".fastagent-context.json", "context.json"]);
});
