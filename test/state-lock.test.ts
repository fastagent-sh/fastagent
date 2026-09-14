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
  // Names the holder (a pid, not just a path) and leads with remedies that exist in a default project.
  await expect(lockAgentState([state])).rejects.toThrow(
    new RegExp(
      `already writing this agent's state \\(pid ${process.pid}\\).*Stop that process.*FASTAGENT_STATE_DIR`,
      "s",
    ),
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

it("a SECOND PROCESS is refused; a killed holder's leftover claim says so instead of naming a dead pid", async () => {
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
  // SIGKILL runs no exit handler, so the claim outlives its holder — and a container restarting into this must not
  // be told to "stop that process". What clears the claim is `proper-lockfile`'s staleness (STALE_MS), its own
  // behaviour: waiting it out here would buy a 15s test.
  await expect(lockAgentState([state])).rejects.toThrow(
    /claimed by a process that is gone \(pid \d+\).*clears itself within 15s/s,
  );
});

it("an opener that fails after taking the claim gives it back, so the retry sees the real error", async () => {
  // Everything between the claim and the return can throw — an unknown model here. Leaked, the retry is refused by
  // its OWN claim and reports the caller's pid, which is advice nobody can act on.
  const dir = fresh("fa-lock-fail-");
  mkdirSync(join(dir, "fastagent"));
  writeFileSync(
    join(dir, "fastagent", "fastagent.config.ts"), // `sessionControl` makes the opener resolve the model registry — the step that rejects an unknown spec.
    `export default { model: "nope/nope", sessionControl: true };\n`,
  );
  for (const attempt of ["first", "second"]) {
    await expect(createPiAgentFromDir(dir, { sessionControl: true }), attempt).rejects.toThrow(
      /unknown model "nope\/nope"/,
    );
  }
});

it("a leftover claim carrying OUR OWN pid reads as gone — the container case, where the agent is pid 1", async () => {
  // A restarted container inherits its predecessor's pid, so asking the OS "is pid 1 alive?" answers yes about
  // itself. Simulated the way the platform leaves it: the lock directory and a pid file this process did not write.
  const state = fresh();
  writeFileSync(join(state, "writer.lock"), `${process.pid}\n`);
  mkdirSync(join(state, "writer.lock.lock"));
  await expect(lockAgentState([state])).rejects.toThrow(/claimed by a process that is gone/);
});

it("a resident boot waits out an expiring claim; a one-shot command refuses instead of hanging", async () => {
  const state = fresh();
  const release = await lockAgentState([state]);
  const booting = lockAgentState([state], { resident: true });
  // Longer than the one-shot budget (~1s), far shorter than the stale window a container would otherwise wait out.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await expect(lockAgentState([state])).rejects.toThrow(/already writing/); // the one-shot posture, unchanged
  await release();
  await (await booting)();
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
