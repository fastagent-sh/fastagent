/**
 * `writeFileAtomic` — the one spelling of "a reader sees the whole file or none of it", after four
 * copies of it drifted apart across the codebase (two identical, two with different temp names and
 * different permission handling).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomic-write.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "fa-atomic-"));

describe("writeFileAtomic", () => {
  it("creates missing parents and leaves no temp behind", () => {
    const dir = fresh();
    const path = join(dir, "nested", "deep", "state.json");
    writeFileAtomic(path, `{"a":1}`);
    expect(readFileSync(path, "utf8")).toBe(`{"a":1}`);
    expect(() => statSync(`${path}.tmp`)).toThrow(/ENOENT/);
  });

  it("applies mode even when a crashed writer left a loose temp behind", () => {
    // `writeFileSync`'s mode option only applies on CREATE. Without the explicit chmod, the stale
    // temp's permissions survive the write and the rename publishes them — a token file at 0644.
    const dir = fresh();
    const path = join(dir, "control.json");
    writeFileSync(`${path}.tmp`, "stale");
    chmodSync(`${path}.tmp`, 0o644);

    writeFileAtomic(path, "secret", 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("leaves the previous file intact when the write fails", () => {
    // How several channel tests inject failure: occupy the temp path with a directory.
    const dir = fresh();
    const path = join(dir, "turns.json");
    writeFileAtomic(path, "good");
    mkdirSync(`${path}.tmp`);

    // The error must be the WRITE failure (syscall `open`), not the cleanup's own complaint about
    // removing a directory (`rm`) — that would bury the reason the write failed.
    expect(() => writeFileAtomic(path, "bad")).toThrow(expect.objectContaining({ syscall: "open" }));
    expect(readFileSync(path, "utf8")).toBe("good"); // never half-written
    rmSync(`${path}.tmp`, { recursive: true });
  });
});
