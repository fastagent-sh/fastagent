// The CLI as a subprocess, for the process-contract tests: cli.test.ts, cli-invoke.test.ts, cli-deploy*.test.ts,
// cli-schedules.test.ts, cli-info.test.ts, cli-login.test.ts and cli-kernel.test.ts's end-to-end block.
// Each run cold-starts the harness, so these tests are spread across files by command to let vitest run them
// in parallel; one file runs its tests serially.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** An agent directory, as `init` produces one; `files` land in it. */
export async function agentWorkspace(prefix: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
  await writeFile(join(dir, ".secrets", "auth.json"), "{}\n"); // a real credential to leak
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Run the CLI to completion, `input` on its stdin, which then ends, as a coding agent's shell hands it; capture stdout, stderr, exit code. */
export function run(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  input = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { ...(cwd ? { cwd } : {}), env: env ?? process.env });
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Two models, gw/m1 the default, that say how many user messages their conversation holds and which of them answered,
 * so a continued conversation is told from a new one. Asked to use a tool, they read SYSTEM.md; to cut, they stop at
 * their token limit; to linger, they note it in the agent's `lingered` file and answer seconds later.
 */
const FAUX_CONFIG = `import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }, { id: "m2" }] });
const reply = (context, _options, _state, model) => {
  const last = context.messages.at(-1);
  const asked = last.role === "user" ? JSON.stringify(last.content) : "";
  if (asked.includes("use a tool")) return fauxAssistantMessage([fauxToolCall("read", { path: "SYSTEM.md" })], { stopReason: "toolUse" });
  if (asked.includes("cut")) return fauxAssistantMessage("cut sho", { stopReason: "length" });
  if (asked.includes("linger")) {
    appendFileSync(new URL("./lingered", import.meta.url), "linger\\n");
    return new Promise((resolve) => setTimeout(() => resolve(fauxAssistantMessage("lingered")), 4000));
  }
  const seen = context.messages.filter((m) => m.role === "user").length;
  return fauxAssistantMessage(model.id === "m1" ? "seen " + seen : "seen " + seen + " by " + model.id);
};
faux.setResponses(Array.from({ length: 50 }, () => reply));
export default { model: "gw/m1", providers: [faux.provider] };
`;

export async function fauxAgent(prefix: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await agentWorkspace(prefix, { "fastagent.config.ts": FAUX_CONFIG, ...files });
  await symlink(new URL("../node_modules", import.meta.url).pathname, join(dir, "node_modules"), "dir");
  return dir;
}

/** How many times the faux model of the agent in `dir` was asked to linger. */
export async function lingered(dir: string): Promise<number> {
  const file = join(dir, "lingered");
  return existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).length : 0;
}

/** Run the CLI until the faux model of the agent in `dir` is lingering, then kill it, as a timeout would. */
export async function killWhileLingering(args: string[], dir: string): Promise<void> {
  const child = spawn(process.execPath, [CLI, ...args]);
  const closed = new Promise((resolve) => child.on("close", resolve));
  const before = await lingered(dir);
  while ((await lingered(dir)) === before) {
    if (child.exitCode !== null) throw new Error(`the CLI exited ${child.exitCode} before the model lingered`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGKILL");
  await closed;
}

/** Hold the instance's storage as a serve of `dir` does, for the length of `during`. */
export async function whileServed<T>(dir: string, during: () => Promise<T>): Promise<T> {
  const held = await openLockedStorage(join(resolveStateRoot(dir), "agent.sqlite"), "posix", "the test's serve");
  try {
    return await during();
  } finally {
    await held.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Run the CLI until its stderr matches `ready`, hand `during` what it said so far, then stop it: a serve, checked
 * while it serves.
 */
export async function whileRunning<T>(
  args: string[],
  ready: RegExp,
  during: (stderr: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const child = spawn(process.execPath, [CLI, ...args], { env });
  const closed = new Promise((resolve) => child.on("close", resolve));
  let stderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (d) => {
        stderr += d;
        if (ready.test(stderr)) resolve();
      });
      child.on("close", (code) => reject(new Error(`the CLI exited ${code} before it was ready:\n${stderr}`)));
    });
    return await during(stderr);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
}
