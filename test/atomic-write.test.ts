/**
 * `writeFileAtomic` — the one spelling of "a reader sees the whole file or none of it", after five
 * copies of it drifted apart across the codebase (two identical, three with different temp names and
 * different permission handling).
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    // temp's permissions survive the write and the rename publishes them — a secret file at 0644.
    const dir = fresh();
    const path = join(dir, "auth.json");
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

  it("takes several processes writing one file when its writers are shared, and none when they are not", async () => {
    // Two processes writing one path through the fixed temp name rename each other's file away (ENOENT) or write one
    // temp at once; a temp of each writer's own does neither, and the last rename wins.
    const source = fileURLToPath(new URL("../src/atomic-write.ts", import.meta.url));
    const script = `import { writeFileAtomic } from ${JSON.stringify(source)};
      const [path, who, shared] = process.argv.slice(1);
      const body = JSON.stringify({ who, pad: who.repeat(64 * 1024) });
      try { for (let i = 0; i < 300; i++) writeFileAtomic(path, body, undefined, shared === "shared"); }
      catch (error) { console.error(error.code); process.exit(1); }`;
    const twoWriters = async (shared: "shared" | "alone") => {
      const path = join(fresh(), "ticket.json");
      writeFileSync(path, "{}");
      const run = (who: string) =>
        new Promise<number | null>((resolve) =>
          spawn(process.execPath, ["--input-type=module", "-e", script, path, who, shared]).on("close", resolve),
        );
      return { codes: await Promise.all([run("a"), run("b")]), path };
    };
    const shared = await twoWriters("shared");
    expect(shared.codes).toEqual([0, 0]);
    expect(JSON.parse(readFileSync(shared.path, "utf8")).who).toMatch(/^[ab]$/);
    // The fixed name is for one writer, as its comment says; two of them fail.
    expect((await twoWriters("alone")).codes).toContain(1);
  });
});
