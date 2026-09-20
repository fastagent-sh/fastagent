import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutines } from "../src/schedule/discover.ts";

const routineHref = new URL("../src/schedule/routine.ts", import.meta.url).href;
const def = (cron: string, prompt = "go", tz?: string): string =>
  `import { defineRoutine } from ${JSON.stringify(routineHref)};\n` +
  `export default defineRoutine({ cron: ${JSON.stringify(cron)}, prompt: ${JSON.stringify(prompt)}${tz ? `, tz: ${JSON.stringify(tz)}` : ""} });\n`;

async function ws(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-sd-"));
  await mkdir(join(dir, "routines"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, "routines", name), content);
  return dir;
}

describe("schedule/discover", () => {
  it("loads valid routines, named from the filename", async () => {
    const dir = await ws({ "daily.ts": def("0 9 * * *", "digest", "UTC") });
    const { routines, failures } = await loadRoutines(dir);
    expect(failures).toEqual([]);
    expect(routines).toEqual([{ name: "daily", cron: "0 9 * * *", tz: "UTC", prompt: "digest" }]);
  });

  it("a routine with NO cron loads — its name is the only way in", async () => {
    // The rename's whole point: `cron` is a field, not the concept. A routine without one is reached
    // by name (`POST /run`, `fastagent routine run`), so its absence is a declaration, not an error.
    const dir = await ws({
      "reindex.ts": `import { defineRoutine } from ${JSON.stringify(routineHref)};\nexport default defineRoutine({ prompt: "refresh" });\n`,
    });
    const { routines, failures } = await loadRoutines(dir);
    expect(failures).toEqual([]);
    expect(routines).toEqual([{ name: "reindex", prompt: "refresh" }]);
  });

  it("refuses a tz with no cron — it would read as a time this routine does not have", async () => {
    const dir = await ws({
      "odd.ts": `import { defineRoutine } from ${JSON.stringify(routineHref)};\nexport default defineRoutine({ prompt: "x", tz: "UTC" });\n`,
    });
    const { routines, failures } = await loadRoutines(dir);
    expect(routines).toEqual([]);
    expect(failures[0]?.message).toMatch(/"tz" means nothing without "cron"/);
  });

  it("isolates a file with an invalid cron — reported, not thrown (G2)", async () => {
    const dir = await ws({ "bad.ts": def("not a cron"), "ok.ts": def("0 * * * *", "hourly") });
    const { routines, failures } = await loadRoutines(dir);
    expect(routines.map((s) => s.name)).toEqual(["ok"]); // the good one still loads
    expect(failures.find((f) => f.label.includes("bad"))?.message).toMatch(/invalid cron/);
  });

  it("isolates a non-schedule default export", async () => {
    const dir = await ws({ "x.ts": "export default { nope: true };\n" });
    const { routines, failures } = await loadRoutines(dir);
    expect(routines).toEqual([]);
    expect(failures[0]?.message).toMatch(/must default-export defineRoutine/);
  });

  it("refuses only names that could leave the claims directory — a legal filename is a legal schedule", async () => {
    // The name becomes a path segment under `claims/`, so that is the whole rule. Narrowing it further would make an
    // ordinary filename load into nothing but one warning, and its schedule would silently stop firing.
    const dir = await ws({
      "...ts": def("0 * * * *"),
      "每日简报.ts": def("0 * * * *"),
      "my report.ts": def("0 * * * *"),
    });
    const { routines, failures } = await loadRoutines(dir);
    expect(routines.map((s) => s.name).sort()).toEqual(["my report", "每日简报"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/cannot be "\.", "\.\." or contain a path separator/);
  });

  it("a missing routines/ dir yields empty (no routines is normal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sd-empty-"));
    expect((await loadRoutines(dir)).routines).toEqual([]);
  });
});
