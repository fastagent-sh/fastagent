/**
 * `writeFileAtomic` — the one spelling of "a reader sees the whole file or none of it", after five
 * copies of it drifted apart across the codebase (two identical, three with different temp names and
 * different permission handling).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fresh = () => mkdtempSync(join(tmpdir(), "fa-atomic-"));

describe("writeFileAtomic", () => {
  it("takes several processes writing one file when its writers are shared, and none when they are not", async () => {
    // Two processes writing one path through the fixed temp name rename each other's file away (ENOENT) or write one
    // temp at once; a temp of each writer's own does neither, and the last rename wins.
    const source = fileURLToPath(new URL("../src/atomic-write.ts", import.meta.url));
    const script = `import { writeFileAtomic } from ${JSON.stringify(source)};
      const [path, who, shared, start] = process.argv.slice(1);
      while (Date.now() < Number(start));
      const body = JSON.stringify({ who, pad: who.repeat(64 * 1024) });
      try { for (let i = 0; i < 300; i++) writeFileAtomic(path, body, undefined, shared === "shared"); }
      catch (error) { console.error(error.code); process.exit(1); }`;
    const twoWriters = async (shared: "shared" | "alone") => {
      const path = join(fresh(), "ticket.json");
      writeFileSync(path, "{}");
      // Both writers start writing at one instant, whatever a loaded machine makes of their startup: a collision that
      // depends on two processes happening to overlap would pass when they did not.
      const start = String(Date.now() + 2000);
      const run = (who: string) =>
        new Promise<number | null>((resolve) =>
          spawn(process.execPath, ["--input-type=module", "-e", script, path, who, shared, start]).on("close", resolve),
        );
      return { codes: await Promise.all([run("a"), run("b")]), path };
    };
    // Two files, so the scenarios run together and share one wait.
    const [shared, alone] = await Promise.all([twoWriters("shared"), twoWriters("alone")]);
    expect(shared.codes).toEqual([0, 0]);
    expect(JSON.parse(readFileSync(shared.path, "utf8")).who).toMatch(/^[ab]$/);
    // The fixed name is for one writer, as its comment says; two of them fail.
    expect(alone.codes).toContain(1);
  });
});
