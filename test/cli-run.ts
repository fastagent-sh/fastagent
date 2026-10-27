// The CLI as a subprocess, for the process-contract tests: cli.test.ts, cli-invoke.test.ts, cli-deploy*.test.ts,
// cli-schedules.test.ts, cli-info.test.ts, cli-login.test.ts and cli-kernel.test.ts's end-to-end block.
// Each run cold-starts the harness, so these tests are spread across files by command to let vitest run them
// in parallel; one file runs its tests serially.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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

/** Run the CLI to completion; capture stdout, stderr, exit code. */
export function run(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { ...(cwd ? { cwd } : {}), env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Two models, gw/m1 the default, that say how many user messages their conversation holds and which of them answered,
 * so a continued conversation is told from a new one, and read SYSTEM.md when asked to use a tool.
 */
const FAUX_CONFIG = `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: "gw", models: [{ id: "m1" }, { id: "m2" }] });
const reply = (context, _options, _state, model) => {
  const last = context.messages.at(-1);
  const asked = last.role === "user" ? JSON.stringify(last.content) : "";
  if (asked.includes("use a tool")) return fauxAssistantMessage([fauxToolCall("read", { path: "SYSTEM.md" })], { stopReason: "toolUse" });
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

/** Hold the instance's storage as a serve of `dir` does, for the length of `during`. */
export async function whileServed<T>(dir: string, during: () => Promise<T>): Promise<T> {
  const held = await openLockedStorage(join(resolveStateRoot(dir), "agent.sqlite"), "posix", "the test's serve");
  try {
    return await during();
  } finally {
    await held.close(BACKGROUND_CONTEXT);
  }
}
