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

/** The store's state IS the file, so assertions read it rather than a getter no channel calls. */
function stored(path: string): Record<string, { humans: string[]; agentSpoke: boolean }> {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "thread-participants-"));
  roots.push(root);
  return root;
}

describe("thread participation (shared)", () => {
  it("the summon rule: takes part, and no second human heard", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");

    expect(store.admitsBareMessage("c:unknown")).toBe(false); // never heard of it

    store.merge("c:listening", { humans: ["u1"] });
    expect(store.admitsBareMessage("c:listening")).toBe(false); // a bystander is not a participant

    store.merge("c:two-party", { humans: ["u1"], agentSpoke: true });
    expect(store.admitsBareMessage("c:two-party")).toBe(true);

    // Zero humans heard is admitted on purpose: ambiguity comes from a SECOND person talking, not from
    // the absence of a first.
    store.merge("c:no-humans", { agentSpoke: true });
    expect(store.admitsBareMessage("c:no-humans")).toBe(true);

    // A second speaker restores the mention requirement, and nothing sheds it afterwards.
    store.merge("c:two-party", { humans: ["u2"] });
    expect(store.admitsBareMessage("c:two-party")).toBe(false);
    store.merge("c:two-party", { humans: ["u1"] });
    expect(store.admitsBareMessage("c:two-party")).toBe(false);
  });

  it("keeps what it heard across a restart, and scopes it per place key", () => {
    const path = join(stateDir(), "p.json");
    const first = createThreadParticipants(path, "[lark]");

    first.merge("oc_1:omt_a", { humans: ["ou_alex"] });
    first.merge("oc_1:omt_a", { agentSpoke: true });
    first.merge("oc_1:omt_a", { humans: ["ou_alex"] }); // already heard — no change

    expect(stored(path)).toEqual({ "oc_1:omt_a": { humans: ["ou_alex"], agentSpoke: true } });

    // A fresh process reads it back and the rule still fires — and only for that exact place.
    const restarted = createThreadParticipants(path, "[lark]");
    expect(restarted.admitsBareMessage("oc_1:omt_a")).toBe(true);
    expect(restarted.admitsBareMessage("oc_other:omt_a")).toBe(false);
    expect(restarted.admitsBareMessage("oc_1:omt_unseen")).toBe(false);
  });

  it("accumulates distinct humans — the rule needs to tell one apart from several", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");

    store.merge("oc_1:omt_a", { humans: ["ou_alex"], agentSpoke: true });
    expect(stored(path)["oc_1:omt_a"]?.humans).toEqual(["ou_alex"]);

    store.merge("oc_1:omt_a", { humans: ["ou_bob"] });
    expect(stored(path)["oc_1:omt_a"]?.humans).toEqual(["ou_alex", "ou_bob"]);
  });

  it("never sheds: an observation cannot be cleared, only added to", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    store.merge("oc_1:omt_a", { humans: ["ou_alex", "ou_bob"], agentSpoke: true });

    // The absence of a signal is not evidence that someone left, and under-counting is the error
    // direction that makes the agent speak into a crowd — so nothing here can subtract.
    store.merge("oc_1:omt_a", { humans: ["ou_alex"] });

    expect(stored(path)["oc_1:omt_a"]).toEqual({ humans: ["ou_alex", "ou_bob"], agentSpoke: true });
  });

  it("stops accumulating humans once a second is known — the rule never asks for more", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    store.merge("oc_1:omt_a", { humans: ["ou_1", "ou_2", "ou_3", "ou_4"] });

    expect(stored(path)["oc_1:omt_a"]?.humans).toEqual(["ou_1", "ou_2"]);
  });

  it("evicts BYSTANDER threads first, so listening traffic cannot push out a thread being served", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    // Oldest of all, but the agent takes part in it — this is the record that costs a mention to lose.
    store.merge("c:served", { humans: ["u1"], agentSpoke: true });
    // Threads it merely listens to are written on the same path and vastly outnumber the rest.
    for (let i = 0; i < 1000; i++) store.merge(`c:bystander_${i}`, { humans: [`u_${i}`] });

    expect(stored(path)["c:served"]).toEqual({ humans: ["u1"], agentSpoke: true });
    expect(stored(path)["c:bystander_0"]).toBeUndefined();
  });

  it("a thread in steady state keeps its place — repeat traffic refreshes recency without writing", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    store.merge("c:served", { humans: ["u1"], agentSpoke: true });
    // Fill with OTHER participant threads, so bystander-first eviction cannot save it.
    for (let i = 0; i < 999; i++) store.merge(`c:other_${i}`, { humans: [`u_${i}`], agentSpoke: true });

    // The served thread carries no NEW information (same human, already answered), which is exactly
    // why it would otherwise sit at the head of the eviction order while being actively served.
    store.merge("c:served", { humans: ["u1"], agentSpoke: true });
    store.merge("c:newest", { humans: ["u_new"], agentSpoke: true });

    expect(stored(path)["c:served"]).toEqual({ humans: ["u1"], agentSpoke: true });
    expect(stored(path)["c:other_0"]).toBeUndefined();
  });

  it("never evicts the thread being written, so a two-step participant record cannot lose its humans", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    // A full map of PARTICIPANT threads: bystander-first eviction has nothing cheap to shed, and the
    // new thread is itself the only bystander — the shape the channels actually produce.
    for (let i = 0; i < 1000; i++) store.merge(`c:other_${i}`, { humans: [`u_${i}`], agentSpoke: true });

    store.merge("c:new", { humans: ["asker"] }); // heard, not yet answered
    store.merge("c:new", { agentSpoke: true }); // the answer, a separate merge

    // Evicting the key under the pen would leave { humans: [], agentSpoke: true }, which admits bare
    // messages from anyone, forever — the under-count the model exists to prevent.
    expect(stored(path)["c:new"]).toEqual({ humans: ["asker"], agentSpoke: true });
    expect(store.admitsBareMessage("c:new")).toBe(true);
    store.merge("c:new", { humans: ["second"] });
    expect(store.admitsBareMessage("c:new")).toBe(false);
  });

  it("evicts the oldest thread once the cap is reached", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    // MAX_THREADS is 1000; touching one more than that must shed exactly the least recently updated.
    for (let i = 0; i <= 1000; i++) store.merge(`oc_1:omt_${i}`, { humans: [`ou_${i}`] });

    expect(stored(path)["oc_1:omt_0"]).toBeUndefined();
    expect(stored(path)["oc_1:omt_1000"]).toEqual({ humans: ["ou_1000"], agentSpoke: false });
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

  it("counts an unidentifiable speaker as distinct — the fail-safe direction", () => {
    const path = join(stateDir(), "p.json");
    const store = createThreadParticipants(path, "[feishu]");
    // Two messages whose sender carries no usable id: they may be one person or two, and the model's
    // asymmetry says to assume the ambiguous case. Two speakers means the thread asks to be named.
    store.merge("c:t", { humans: ["unidentified:om_1"], agentSpoke: true });
    store.merge("c:t", { humans: ["unidentified:om_2"] });

    expect(stored(path)["c:t"]?.humans).toHaveLength(2);
  });

  it("warns and starts empty when valid JSON has the wrong shape", () => {
    const path = join(stateDir(), "p.json");
    writeFileSync(path, JSON.stringify({ "oc_1:omt_a": { humans: "nope", agentSpoke: true } }));
    const warnings: string[] = [];
    vi.spyOn(log, "warn").mockImplementation((message) => warnings.push(message));

    const store = createThreadParticipants(path, "[feishu]");

    expect(store.admitsBareMessage("oc_1:omt_a")).toBe(false);
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

    // Nothing reached disk, but this process still answers correctly — the file is a cache.
    expect(store.admitsBareMessage("oc_1:omt_a")).toBe(true);
    expect(warnings.some((message) => message.includes("could not persist thread participation"))).toBe(true);
  });
});
