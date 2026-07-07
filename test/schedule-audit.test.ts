import { describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRun, readRuns } from "../src/schedule/audit.ts";

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

  it("skips a malformed line with a warn — one bad line can't poison the history", async () => {
    const r = await root();
    appendRun(r, rec("a"));
    appendFileSync(join(r, "schedule", "runs.jsonl"), "not json\n{}\n");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readRuns(r, "a")).toHaveLength(1); // the good record survives
    vi.restoreAllMocks();
  });
});
