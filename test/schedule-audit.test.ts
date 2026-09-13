import { describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRun, latestFiredAt, readRuns } from "../src/schedule/audit.ts";

const root = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-audit-"));
const rec = (name: string, outcome: "completed" | "failed" | "deferred" = "completed") => ({
  name,
  session: `schedule:${name}`,
  firedAt: "2026-07-07T09:00:00.000Z",
  ms: 1200,
  outcome,
  reply: outcome === "completed" ? "the digest, in full — not capped" : undefined,
  error: outcome === "failed" ? "boom" : undefined,
});

describe("schedule/audit (runs.jsonl)", () => {
  it("appendRun + readRuns roundtrip, oldest first, FULL reply preserved", async () => {
    const r = await root();
    appendRun(r, rec("daily"));
    appendRun(r, rec("daily", "failed"));
    const runs = readRuns(r, "daily");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.reply).toBe("the digest, in full — not capped"); // full text, not a preview
    expect(runs[1]).toMatchObject({ outcome: "failed", error: "boom" });
  });

  it("filters by name; no filter returns all; missing file is an empty history", async () => {
    const r = await root();
    appendRun(r, rec("a"));
    appendRun(r, rec("wake"));
    expect(readRuns(r, "a")).toHaveLength(1);
    expect(readRuns(r)).toHaveLength(2);
    expect(readRuns(await root())).toEqual([]); // fresh root, no file
  });

  it("latestFiredAt: newest per name, unfooled by a reply quoting the field, no record parsed", async () => {
    const r = await root();
    appendRun(r, { ...rec("daily"), firedAt: "2026-07-07T09:00:00.000Z" });
    // A reply can contain anything, but JSON escapes its quotes — so `"firedAt":"` inside it is not that sequence.
    appendRun(r, {
      ...rec("daily"),
      firedAt: "2026-07-07T10:00:00.000Z",
      reply: 'the cron said {"name":"other","firedAt":"1999-01-01T00:00:00.000Z"}',
    });
    appendRun(r, { ...rec("weekly"), firedAt: "2026-07-06T09:00:00.000Z" });
    expect([...latestFiredAt(r)]).toEqual([
      ["daily", "2026-07-07T10:00:00.000Z"],
      ["weekly", "2026-07-06T09:00:00.000Z"],
    ]);
    expect(latestFiredAt(await root())).toEqual(new Map()); // fresh root, no file
  });

  it("skips a malformed line with a warn — one bad line can't poison the history", async () => {
    const r = await root();
    appendRun(r, rec("a"));
    appendFileSync(join(r, "schedule", "runs.jsonl"), "not json\n{}\n");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readRuns(r, "a")).toHaveLength(1); // the good record survives
    vi.restoreAllMocks();
  });
});
