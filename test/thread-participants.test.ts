import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    first.merge("oc_1:omt_a", { humans: ["ou_alex"], derived: true }); // a listing completes it

    expect(first.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true, derived: true });
    // Only observations are persisted: `derived` is process-local, so a restart re-establishes.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "oc_1:omt_a": { humans: ["ou_alex"], agentSpoke: true },
    });

    const restarted = createThreadParticipants(path, "[lark]");
    expect(restarted.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true, derived: false });
    expect(restarted.get("oc_other:omt_a")).toBeUndefined(); // participation is per chat
    expect(restarted.get("oc_1:omt_unseen")).toBeUndefined();
  });

  it("only a platform listing completes the record: the agent's own reply does not", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");

    store.merge("oc_1:omt_a", { humans: ["ou_alex"] });
    store.merge("oc_1:omt_a", { agentSpoke: true });
    // The agent replying proves it takes part, but says nothing about who ELSE is in the thread —
    // the half the summon rule counts.
    expect(store.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true, derived: false });

    store.merge("oc_1:omt_a", { humans: ["ou_alex", "ou_bob"], derived: true });
    expect(store.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex", "ou_bob"], agentSpoke: true, derived: true });
  });

  it("a derived listing REPLACES the human set, which is how a restart's re-establish sheds a departed human", () => {
    const path = join(stateDir(), "p.json");
    const first = createThreadParticipants(path, "[feishu]");
    first.merge("oc_1:omt_a", { humans: ["ou_alex", "ou_bob"], agentSpoke: true, derived: true });

    // A listing answers "who is here now". Within one process it runs once per thread, so the replace
    // matters on the NEXT process: the observations survive, `derived` does not, and the fresh listing
    // of a thread that has quietened to two parties replaces the pair with the one who remains.
    const restarted = createThreadParticipants(path, "[feishu]");
    expect(restarted.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex", "ou_bob"], agentSpoke: true, derived: false });

    restarted.merge("oc_1:omt_a", { humans: ["ou_alex"], derived: true });
    expect(restarted.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true, derived: true });
  });

  it("accumulates distinct humans — the summon rule needs to tell one apart from several", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true });
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_alex"]);

    store.merge("oc_1:omt_a", { humans: ["ou_bob"] });
    expect(store.get("oc_1:omt_a")?.humans).toEqual(["ou_alex", "ou_bob"]);
  });

  it("records a thread that answered with no senders, so an unreadable thread is not re-read forever", () => {
    const store = createThreadParticipants(join(stateDir(), "p.json"), "[feishu]");
    store.merge("oc_1:omt_dead", { derived: true });
    expect(store.get("oc_1:omt_dead")).toEqual({ humans: [], agentSpoke: false, derived: true });
  });

  it("warns and starts empty when valid JSON has the wrong shape", () => {
    const path = join(stateDir(), "p.json");
    writeFileSync(
      path,
      JSON.stringify({ "oc_1:omt_a": { humans: "nope", agentSpoke: true, derived: true, updatedAt: 1 } }),
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

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true, derived: true });

    expect(store.get("oc_1:omt_a")).toEqual({ humans: ["ou_alex"], agentSpoke: true, derived: true });
    expect(warnings.some((message) => message.includes("could not persist thread participation"))).toBe(true);
  });
});
