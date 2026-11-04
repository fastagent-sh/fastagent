// Two ways to run the CLI in a test. `run` spawns it as a PROCESS, for the contracts only a process has: exit codes
// and stdout/stderr discipline across a real pipe (cli.test.ts, cli-kernel.test.ts's end-to-end block), a command that
// outlives its caller (the ticket tests in cli-login/cli-deploy), a signal, a kill. `runInProcess` calls the same entry
// in this process, for everything that is about what a COMMAND decides: ~0.5-1s of CPU cheaper per call.
// Rule of thumb: reach for `runInProcess`; use `run` when the test would be wrong if no process were involved.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const REPO_MODULES = new URL("../node_modules", import.meta.url).pathname;

/** What `init` gives a project that `fastagent build` (and so `deploy` and `start`) needs: an ES module package and TypeScript. */
export async function buildable(dir: string): Promise<void> {
  await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
  await mkdir(join(dir, "node_modules", "@fastagent-sh"), { recursive: true });
  await symlink(
    new URL("./fixtures/fastagent-shim", import.meta.url).pathname,
    join(dir, "node_modules", "@fastagent-sh", "fastagent"),
    "dir",
  );
  await mkdir(join(dir, "node_modules", "@typescript"), { recursive: true });
  await symlink(join(REPO_MODULES, "typescript"), join(dir, "node_modules", "typescript"), "dir");
  for (const entry of await readdir(join(REPO_MODULES, "@typescript"))) {
    await symlink(join(REPO_MODULES, "@typescript", entry), join(dir, "node_modules", "@typescript", entry), "dir");
  }
}

/** The agent in `dir` built into its `dist/`, which `start` opens: what `fastagent build` or `npm start` has done. */
export async function built(dir: string): Promise<string> {
  await buildProject(dir);
  return dir;
}

/** An agent directory, as `init` produces one; `files` land in it. */
export async function agentWorkspace(prefix: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
  await writeFile(join(dir, ".secrets", "auth.json"), "{}\n"); // a real credential to leak
  await buildable(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Run the CLI to completion, its stdin ended at once as a coding agent's shell hands it; capture stdout, stderr, exit code. */
export function run(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { ...(cwd ? { cwd } : {}), env: env ?? process.env });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type Listener = (...args: any[]) => void;

/** Thrown by the stand-in `process.exit` so the command stops where the real one would. */
class Exited extends Error {}

let inProcessQueue: Promise<unknown> = Promise.resolve();

/**
 * {@link run}'s answer without a process: the same CLI entry, called in this one, for a test whose contract is
 * what a COMMAND decides (its exit code, what it prints, what it writes) rather than what a PROCESS does.
 * A cold-started CLI costs ~0.5-1s of CPU; this costs the command.
 *
 * What it stands in for, and puts back afterwards: the working directory, the whole environment, `process.exit`
 * (the FIRST code wins, as in a process that has exited; a command's own `catch` may call it again on the way
 * out), `process.exitCode`, stdout/stderr, and the signal/exit listeners the command added. Runs are serialized,
 * since they share all of that. It is stdin-less and TTY-less, as `run` is.
 *
 * NOT for a test that is about the process itself: a command that outlives it (a ticket's background process,
 * which signals its process group on exit), stdout/stderr discipline across a real pipe, a signal, a crash.
 * Those stay on {@link run}; `cli-run-parity.test.ts` pins that the two agree.
 */
export function runInProcess(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const turn = inProcessQueue.then(() => runOnce(args, cwd, env ?? process.env));
  inProcessQueue = turn.catch(() => undefined);
  return turn;
}

async function runOnce(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv) {
  const { runCli } = await import("../src/cli/program.ts");
  const saved = {
    cwd: process.cwd(),
    env: { ...process.env },
    exit: process.exit,
    exitCode: process.exitCode,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
    console: { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug },
    tty: [process.stdin, process.stdout, process.stderr].map((stream) =>
      Object.getOwnPropertyDescriptor(stream, "isTTY"),
    ),
    listeners: new Map<string | symbol, Listener[]>(),
  };
  for (const event of process.eventNames())
    saved.listeners.set(event, [...(process.listeners(event as never) as Listener[])]);
  const given = { ...env }; // before anything below changes what `env` may alias (process.env itself)

  let stdout = "";
  let stderr = "";
  let exited: number | undefined;
  const text = (chunk: unknown): string =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
  const to =
    (sink: "out" | "err") =>
    (...parts: unknown[]) => {
      const line = `${parts.map((part) => (typeof part === "string" ? part : inspect(part))).join(" ")}\n`;
      if (sink === "out") stdout += line;
      else stderr += line;
    };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, given);
    process.chdir(cwd ?? saved.cwd);
    process.exitCode = undefined;
    for (const stream of [process.stdin, process.stdout, process.stderr]) {
      Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
    }
    process.stdout.write = ((chunk: unknown) => {
      stdout += text(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += text(chunk);
      return true;
    }) as typeof process.stderr.write;
    console.log = console.info = console.debug = to("out");
    console.warn = console.error = to("err");
    process.exit = ((code?: number) => {
      exited ??= code ?? (typeof process.exitCode === "number" ? process.exitCode : 0);
      throw new Exited();
    }) as typeof process.exit;
    try {
      await runCli(["node", "fastagent", ...args]);
    } catch (error) {
      if (!(error instanceof Exited)) throw error;
    }
    const code = exited ?? (typeof process.exitCode === "number" ? process.exitCode : 0);
    return { code, stdout, stderr };
  } finally {
    process.exit = saved.exit;
    process.stdout.write = saved.stdoutWrite;
    process.stderr.write = saved.stderrWrite;
    Object.assign(console, saved.console);
    [process.stdin, process.stdout, process.stderr].forEach((stream, i) => {
      const was = saved.tty[i];
      if (was) Object.defineProperty(stream, "isTTY", was);
      else delete (stream as { isTTY?: boolean }).isTTY;
    });
    process.chdir(saved.cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
    process.exitCode = saved.exitCode;
    for (const event of process.eventNames()) {
      const before = saved.listeners.get(event) ?? [];
      for (const listener of process.listeners(event as never) as Listener[]) {
        if (!before.includes(listener)) process.removeListener(event as never, listener);
      }
    }
  }
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
export default { defaults: { model: "gw/m1" }, providers: [faux.provider] };
`;

/** The agent in `dir` given this repository's dependencies, for a config that imports them. */
export async function withRepoModules(dir: string): Promise<void> {
  await rm(join(dir, "node_modules"), { recursive: true });
  await symlink(REPO_MODULES, join(dir, "node_modules"), "dir");
}

export async function fauxAgent(prefix: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await agentWorkspace(prefix, { "fastagent.config.ts": FAUX_CONFIG, ...files });
  await withRepoModules(dir);
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
