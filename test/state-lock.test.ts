import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { lockAgentState } from "../src/state-lock.ts";
import { createPiAgentFromDir } from "../src/engines/pi/open.ts";

const dirs: string[] = [];
const fresh = (prefix = "fa-lock-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("refuses a second writer over one directory, names it, and gives ownership back on release", async () => {
  const state = fresh();
  const release = await lockAgentState([state]);
  await expect(lockAgentState([state])).rejects.toThrow(
    /another process is already writing this agent's state .*fastagent attach.*FASTAGENT_STATE_DIR/s,
  );
  await release();
  await (await lockAgentState([state]))(); // free again — a normal close is not a permanent claim
});

it("guards each resolved write path, so a shared sessions dir collides under different state roots", async () => {
  // The override is the case a nominal state-root guard misses: two runs whose state roots differ but whose journals
  // are the same directory.
  const sessions = fresh("fa-lock-sessions-");
  const release = await lockAgentState([fresh(), sessions]);
  await expect(lockAgentState([fresh(), sessions])).rejects.toThrow(/already writing/);
  await release();
});

it("leaves independent directories alone", async () => {
  const first = await lockAgentState([fresh()]);
  const second = await lockAgentState([fresh()]);
  await first();
  await second();
});

it("a SECOND PROCESS is refused; a SIGKILLed holder's claim expires instead of needing a human", async () => {
  const state = fresh();
  const source = new URL("../src/state-lock.ts", import.meta.url).href;
  const hold = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      const { lockAgentState } = await import(${JSON.stringify(source)});
      // Holding a lock does not keep a process alive (the refresh timer is unref'd) — the IPC channel does.
      process.on("message", () => {});
      await lockAgentState([${JSON.stringify(state)}]);
      process.send("held");
      `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(hold, "exit");
  try {
    expect(await Promise.race([once(hold, "message").then(([value]) => value), exited])).toBe("held");
    await expect(lockAgentState([state])).rejects.toThrow(/already writing/);
  } finally {
    hold.kill("SIGKILL"); // no exit handler runs: the claim can only expire
    await exited;
  }
  // SIGKILL runs no exit handler, so the claim is still there — and expires on its own within the stale window.
  await expect(lockAgentState([state])).rejects.toThrow(/already writing/);
});

it("the opener takes ownership, and `exclusive: false` is how a caller declines it", async () => {
  const dir = fresh("fa-lock-agent-");
  mkdirSync(join(dir, "fastagent"));
  writeFileSync(join(dir, "fastagent", "fastagent.config.ts"), `export default { model: "openai-codex/gpt-5.5" };\n`);
  const opened = await createPiAgentFromDir(dir);
  await expect(createPiAgentFromDir(dir)).rejects.toThrow(/already writing/);
  // The opt-out is for a caller that owns the coordination itself.
  expect((await createPiAgentFromDir(dir, { exclusive: false })).releaseState).toBeUndefined();
  await opened.releaseState?.();
  await (await createPiAgentFromDir(dir)).releaseState?.();
});
