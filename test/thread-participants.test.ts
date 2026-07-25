import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadParticipants } from "../src/channels/thread-participants.ts";
import { log } from "../src/log.ts";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "feishu-participants-"));
  roots.push(root);
  return root;
}

describe("thread participation (shared)", () => {
  it("merges observations, keeps them across a restart, and scopes them per chat", () => {
    const path = join(stateDir(), "thread-participants.json");
    const first = createThreadParticipants(path, "[lark]");

    first.merge("oc_1:omt_a", { humans: ["ou_alex"] });
    first.merge("oc_1:omt_a", { agentSpoke: true }); // the agent's own reply: its half only
    first.merge("oc_1:omt_a", { humans: ["ou_alex"] }); // already known — no change
    first.merge("oc_1:omt_a", { humans: ["ou_alex"], established: true }); // a listing completes it

    expect(first.get("oc_1:omt_a")).toEqual({
      humans: ["ou_alex"],
      agentSpoke: true,
      established: true,
      unreadable: false,
    });
    // Only observations are persisted: `established` is process-local, so a restart re-establishes.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "oc_1:omt_a": { humans: ["ou_alex"], agentSpoke: true },
    });

    const restarted = createThreadParticipants(path, "[lark]");
    expect(restarted.get("oc_1:omt_a")).toEqual({
      humans: ["ou_alex"],
      agentSpoke: true,
      established: false,
      unreadable: false,
    });
    expect(restarted.get("oc_other:omt_a")).toBeUndefined(); // participation is per chat
    expect(restarted.get("oc_1:omt_unseen")).toBeUndefined();
  });

  it("only a platform listing completes the record: the agent's own reply does not", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");

    store.merge("oc_1:omt_a", { humans: ["ou_alex"] });
    store.merge("oc_1:omt_a", { agentSpoke: true });
    // The agent replying proves it takes part, but says nothing about who ELSE is in the thread —
    // the half the summon rule counts.
    expect(store.get("oc_1:omt_a")).toEqual({
      humans: ["ou_alex"],
      agentSpoke: true,
      established: false,
      unreadable: false,
    });

    store.merge("oc_1:omt_a", { humans: ["ou_alex", "ou_bob"], established: true });
    expect(store.get("oc_1:omt_a")).toEqual({
      humans: ["ou_alex", "ou_bob"],
      agentSpoke: true,
      established: true,
      unreadable: false,
    });
  });

  it("a listing UNIONS with what was observed: over-counting is safe, under-counting is not", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    store.merge("oc_1:omt_a", { humans: ["ou_bob"] }); // observed live

    // The listing reads the thread's start, so it can miss someone who spoke only recently — and the
    // observations can miss someone who spoke only before this process watched. Neither may erase the
    // other: a human dropped from the set would let the agent speak unprompted in a crowded thread.
    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true, established: true });

    expect(store.get("oc_1:omt_a")).toEqual({
      humans: ["ou_bob", "ou_alex"],
      agentSpoke: true,
      established: true,
      unreadable: false,
    });
  });

  it("accumulates distinct humans — the summon rule needs to tell one apart from several", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true });
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_alex"]);

    store.merge("oc_1:omt_a", { humans: ["ou_bob"] });
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_alex", "ou_bob"]);
  });

  it("an unreadable thread is remembered as such WITHOUT claiming its humans are known", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    store.merge("oc_1:omt_dead", { unreadable: true });

    // The two flags mean different things: "do not ask again" must never imply "the human set is
    // established", or a refusal would promote an observed-only record into an authoritative one.
    expect(store.get("oc_1:omt_dead")).toEqual({
      humans: [],
      agentSpoke: false,
      established: false,
      unreadable: true,
    });
  });

  it("evicts the oldest thread once the cap is reached, and keeps its flags with it", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    // MAX_THREADS is 5000; touching one more than that must shed exactly the least recently updated.
    for (let i = 0; i <= 5000; i++) store.merge(`oc_1:omt_${i}`, { humans: [`ou_${i}`], established: true });

    expect(store.get("oc_1:omt_0")).toBeUndefined(); // oldest gone, flags with it
    expect(store.get("oc_1:omt_5000")).toEqual({
      humans: ["ou_5000"],
      agentSpoke: false,
      established: true,
      unreadable: false,
    });
  });

  it("persists only NEW observations — a repeat message writes nothing", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");

    // The write is a synchronous whole-map rewrite on the pre-ACK path, so it must be driven by new
    // information, not by traffic: a busy thread the agent only listens to would otherwise rewrite
    // the file for every message it sees.
    store.merge("c:t1", { humans: ["u1"] });
    expect(existsSync(path)).toBe(true);

    rmSync(path); // if a repeat observation wrote, the file would come back
    for (let i = 0; i < 99; i++) store.merge("c:t1", { humans: ["u1"] });
    expect(existsSync(path)).toBe(false);

    store.merge("c:t1", { humans: ["u2"] }); // a second human IS new information
    expect(existsSync(path)).toBe(true);

    rmSync(path);
    for (let i = 0; i < 99; i++) store.merge("c:t1", { humans: [i % 2 ? "u1" : "u2"] });
    expect(existsSync(path)).toBe(false); // MAX_HUMANS reached: nothing new can arrive for this thread
  });

  it("bounds the flag map on its own — an unreadable thread stores no observation to evict with", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    // Nothing is persisted for these, so the record cap can never reach them: without its own bound
    // the flag map would keep one entry per unreadable thread for the life of the process.
    for (let i = 0; i <= 5000; i++) store.merge(`oc_1:omt_${i}`, { unreadable: true });

    expect(store.get("oc_1:omt_0")).toBeUndefined();
    expect(store.get("oc_1:omt_5000")).toEqual({
      humans: [],
      agentSpoke: false,
      established: false,
      unreadable: true,
    });
  });

  it("stops accumulating humans once a second is known — the rule never asks for more", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    store.merge("oc_1:omt_a", { humans: ["ou_1", "ou_2", "ou_3", "ou_4"], established: true });

    // Two is already the whole answer to "is more than one human here?".
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_1", "ou_2"]);
  });

  it("warns and starts empty when valid JSON has the wrong shape", () => {
    const path = join(stateDir(), "p.json");
    writeFileSync(
      path,
      JSON.stringify({ "oc_1:omt_a": { humans: "nope", agentSpoke: true, established: true, updatedAt: 1 } }),
    );
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    const store = createThreadParticipants(path, "[feishu]");

    expect(store.get("oc_1:omt_a")).toBeUndefined();
    expect(warnings.some((message) => message.includes("starting with no thread participation"))).toBe(true);
  });

  it("a failed write warns but keeps participation in memory (cache, not source of truth)", () => {
    const root = stateDir();
    // Block the write at the seam: the state file's parent path is a FILE, so saveStateFile's mkdir
    // throws everywhere (mode bits would be a no-op for root in CI containers).
    const blocker = join(root, "sub");
    const store = createThreadParticipants(join(blocker, "p.json"), "[feishu]");
    writeFileSync(blocker, "");
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true, established: true });

    expect(store.get("oc_1:omt_a")).toEqual({
      humans: ["ou_alex"],
      agentSpoke: true,
      established: true,
      unreadable: false,
    });
    expect(warnings.some((message) => message.includes("could not persist thread participation"))).toBe(true);
  });
});
