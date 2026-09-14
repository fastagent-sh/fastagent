import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolve } from "node:path";
import { lockAgentState } from "../src/state-lock.ts";

/** The claim's path — mirrors `socketFor`, so a test can occupy or inspect it. */
const socketFor = (dir: string): string =>
  `/tmp/fastagent-${createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16)}.sock`;
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

/** A holder in its own process, which is the only way to test a claim this one does not own. */
function holder(dir: string): {
  pid: number;
  started(): Promise<void>;
  kill: (signal: NodeJS.Signals) => Promise<void>;
} {
  const source = new URL("../src/state-lock.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      const { lockAgentState } = await import(${JSON.stringify(source)});
      process.on("message", () => {}); // the claim is unref'd, so the IPC channel is what keeps this alive
      await lockAgentState([${JSON.stringify(dir)}]);
      process.send("held");
      `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const exited = once(child, "exit");
  return {
    pid: child.pid ?? 0,
    kill: async (signal) => {
      child.kill(signal);
      await exited;
    },
    async started() {
      const first = await Promise.race([once(child, "message").then(([value]) => value), exited]);
      if (first !== "held") throw new Error(`holder exited before taking the claim: ${String(first)}`);
    },
  };
}

it("refuses a second opener in THIS process with the remedy that applies to it, and frees on release", async () => {
  // The embedder's shape of the conflict: two opens of one directory in one process. "Stop that process" would name
  // the caller itself, so this case has its own wording — and the holder it names is this process, as a fact.
  const state = fresh();
  const release = await lockAgentState([state]);
  await expect(lockAgentState([state])).rejects.toThrow(
    /this process already opened this agent's state.*Close the first agent/s,
  );
  await release();
  await (await lockAgentState([state]))(); // free again — a normal close is not a permanent claim
});

it("names the holder from the holder: its pid and command, not a guess about a file", async () => {
  const state = fresh();
  const held = holder(state);
  await held.started();
  try {
    await expect(lockAgentState([state])).rejects.toThrow(
      new RegExp(`another process is already writing this agent's state — pid ${held.pid}.*Stop that process`, "s"),
    );
  } finally {
    await held.kill("SIGKILL");
  }
});

it("a killed holder's claim is gone the moment it is: the next taker just takes it", async () => {
  // This is why the claim is a socket. A lock FILE outlives its process, which is where a stale window, a heartbeat,
  // and asking the OS about a pid (pid 1 in a container — itself) all came from.
  const state = fresh();
  const held = holder(state);
  await held.started();
  await held.kill("SIGKILL"); // no exit handler runs; the socket file stays on disk
  await (await lockAgentState([state]))();
});

it("guards each resolved write path, so a shared sessions dir collides under different state roots", async () => {
  // The override is the case a nominal state-root guard misses: two runs whose state roots differ but whose journals
  // are the same directory.
  const sessions = fresh("fa-lock-sessions-");
  const release = await lockAgentState([fresh(), sessions]);
  await expect(lockAgentState([fresh(), sessions])).rejects.toThrow(/already opened this agent's state/);
  await release();
});

it("leaves independent directories alone, and gives back a partial claim that cannot be completed", async () => {
  const first = await lockAgentState([fresh()]);
  const second = await lockAgentState([fresh()]);
  await first();
  await second();

  // A run's two paths are claimed in order, and the second can be held by someone else (a sessions directory shared
  // with a serving process). Without the rollback the caller gets an exception and no release handle, so nothing
  // could give the first one back before this process exits.
  const state = fresh();
  const sessions = fresh("fa-lock-sessions-");
  const held = holder(sessions);
  await held.started();
  try {
    await expect(lockAgentState([state, sessions])).rejects.toThrow(/another process is already writing/);
    await (await lockAgentState([state]))(); // the first path came back
  } finally {
    await held.kill("SIGKILL");
  }
});

it("a holder too busy to answer is NOT treated as dead — the claim it holds is not taken from it", async () => {
  // A service under load (a synchronous parse of a large journal, a CPU-throttled container) can miss the probe
  // window. Assuming it is gone and unlinking its claim is the exact state this guard exists to prevent, so an
  // unanswered probe refuses instead — a refused run is recoverable, two writers are not.
  const state = fresh();
  const path = socketFor(state);
  const silent = createServer(() => {}); // accepts, never answers
  await new Promise<void>((done) => silent.listen(path, done));
  try {
    await expect(lockAgentState([state])).rejects.toThrow(/did not answer within \d+ms.*refusing rather than/s);
    expect(existsSync(path)).toBe(true); // and its claim is still there
  } finally {
    await new Promise((done) => silent.close(done));
  }
});

it("a takeover in progress refuses instead of racing it — no second unlink of the winner's name", async () => {
  // "Unlink the dead name, then bind it" is the only non-atomic step here: two takers could each delete what the
  // other just bound and both believe they are alone. The sentinel makes the loser a refusal.
  const state = fresh();
  const path = socketFor(state);
  const held = holder(state);
  await held.started();
  await held.kill("SIGKILL"); // a genuinely dead claim: the socket file is there, nothing listens
  writeFileSync(`${path}.takeover`, ""); // …and a takeover is already in flight
  try {
    await expect(lockAgentState([state])).rejects.toThrow(/another process is taking it over/);
    expect(existsSync(path)).toBe(true); // the loser removed nothing
  } finally {
    rmSync(`${path}.takeover`, { force: true });
    rmSync(path, { force: true });
  }
});

it("a stray file where a claim should be is refused, not deleted", async () => {
  const state = fresh();
  const path = socketFor(state);
  writeFileSync(path, "not a socket");
  try {
    await expect(lockAgentState([state])).rejects.toThrow(/ENOTSOCK.*refusing rather than assuming/s);
    expect(existsSync(path)).toBe(true);
  } finally {
    rmSync(path, { force: true });
  }
});

it("the opener takes ownership, and disposing is how the same directory is opened again", async () => {
  const dir = fresh("fa-lock-agent-");
  mkdirSync(join(dir, "fastagent"));
  writeFileSync(join(dir, "fastagent", "fastagent.config.ts"), `export default { model: "openai-codex/gpt-5.5" };\n`);
  const opened = await createPiAgentFromDir(dir);
  await expect(createPiAgentFromDir(dir)).rejects.toThrow(/already opened this agent's state/);
  await opened.dispose();
  await (await createPiAgentFromDir(dir)).dispose();
});

it("an opener that fails after taking the claim gives it back, so the retry sees the real error", async () => {
  // Everything between the claim and the return can throw — an unknown model here. Leaked, the retry is refused by
  // its OWN claim and reports the caller's pid, which is advice nobody can act on.
  const dir = fresh("fa-lock-fail-");
  mkdirSync(join(dir, "fastagent"));
  writeFileSync(
    join(dir, "fastagent", "fastagent.config.ts"),
    // `sessionControl` makes the opener resolve the model registry — the step that rejects an unknown spec.
    `export default { model: "nope/nope", sessionControl: true };\n`,
  );
  for (const attempt of ["first", "second"]) {
    await expect(createPiAgentFromDir(dir, { sessionControl: true }), attempt).rejects.toThrow(
      /unknown model "nope\/nope"/,
    );
  }
});
