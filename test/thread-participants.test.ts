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
  const root = mkdtempSync(join(tmpdir(), "thread-participants-"));
  roots.push(root);
  return root;
}

describe("thread participation (shared)", () => {
  it("keeps what it heard across a restart, and scopes it per place key", () => {
    const path = join(stateDir(), "p.json");
    const first = createThreadParticipants(path, "[lark]");

    first.merge("oc_1:omt_a", { humans: ["ou_alex"] });
    first.merge("oc_1:omt_a", { agentSpoke: true });
    first.merge("oc_1:omt_a", { humans: ["ou_alex"] }); // already heard — no change

    expect(first.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "oc_1:omt_a": { humans: ["ou_alex"], agentSpoke: true },
    });

    const restarted = createThreadParticipants(path, "[lark]");
    expect(restarted.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true });
    expect(restarted.get("oc_other:omt_a")).toBeUndefined();
    expect(restarted.get("oc_1:omt_unseen")).toBeUndefined();
  });

  it("accumulates distinct humans — the rule needs to tell one apart from several", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true });
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_alex"]);

    store.merge("oc_1:omt_a", { humans: ["ou_bob"] });
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_alex", "ou_bob"]);
  });

  it("never sheds: an observation cannot be cleared, only added to", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    store.merge("oc_1:omt_a", { humans: ["ou_alex", "ou_bob"], agentSpoke: true });

    // The absence of a signal is not evidence that someone left, and under-counting is the error
    // direction that makes the agent speak into a crowd — so nothing here can subtract.
    store.merge("oc_1:omt_a", { humans: ["ou_alex"] });

    expect(store.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex", "ou_bob"], agentSpoke: true });
  });

  it("stops accumulating humans once a second is known — the rule never asks for more", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    store.merge("oc_1:omt_a", { humans: ["ou_1", "ou_2", "ou_3", "ou_4"] });

    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_1", "ou_2"]);
  });

  it("evicts the oldest thread once the cap is reached", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    // MAX_THREADS is 5000; touching one more than that must shed exactly the least recently updated.
    for (let i = 0; i <= 5000; i++) store.merge(`oc_1:omt_${i}`, { humans: [`ou_${i}`] });

    expect(store.get("oc_1:omt_0")).toBeUndefined();
    expect(store.get("oc_1:omt_5000")).toEqual({ humans: ["ou_5000"], agentSpoke: false });
  });

  it("persists only NEW observations — a repeat message writes nothing", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");

    // The write is a synchronous whole-map rewrite on the acceptance path, so it must be driven by new
    // information, not by traffic: a busy thread the agent only listens to would otherwise rewrite the
    // file for every message it sees.
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

  it("warns and starts empty when valid JSON has the wrong shape", () => {
    const path = join(stateDir(), "p.json");
    writeFileSync(path, JSON.stringify({ "oc_1:omt_a": { humans: "nope", agentSpoke: true } }));
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    const store = createThreadParticipants(path, "[feishu]");

    expect(store.get("oc_1:omt_a")).toBeUndefined();
    expect(warnings.some((message) => message.includes("starting with no thread participation"))).toBe(true);
  });

  it("a failed write warns but keeps what it heard in memory (cache, not source of truth)", () => {
    const root = stateDir();
    // Block the write at the seam: the state file's parent path is a FILE, so saveStateFile's mkdir
    // throws everywhere (mode bits would be a no-op for root in CI containers).
    const blocker = join(root, "sub");
    const store = createThreadParticipants(join(blocker, "p.json"), "[feishu]");
    writeFileSync(blocker, "");
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true });

    expect(store.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true });
    expect(warnings.some((message) => message.includes("could not persist thread participation"))).toBe(true);
  });
});
