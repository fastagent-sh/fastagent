import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSchedules } from "../src/schedule/discover.ts";

const scheduleHref = new URL("../src/schedule/schedule.ts", import.meta.url).href;
const def = (cron: string, prompt = "go", tz?: string): string =>
  `import { defineSchedule } from ${JSON.stringify(scheduleHref)};\n` +
  `export default defineSchedule({ cron: ${JSON.stringify(cron)}, prompt: ${JSON.stringify(prompt)}${tz ? `, tz: ${JSON.stringify(tz)}` : ""} });\n`;

async function ws(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-sd-"));
  await mkdir(join(dir, "schedules"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, "schedules", name), content);
  return dir;
}

describe("schedule/discover", () => {
  it("loads valid schedules, named from the filename", async () => {
    const dir = await ws({ "daily.ts": def("0 9 * * *", "digest", "UTC") });
    const { schedules, failures } = await loadSchedules(dir);
    expect(failures).toEqual([]);
    expect(schedules).toEqual([{ name: "daily", cron: "0 9 * * *", tz: "UTC", prompt: "digest" }]);
  });

  it("isolates a file with an invalid cron — reported, not thrown (G2)", async () => {
    const dir = await ws({ "bad.ts": def("not a cron"), "ok.ts": def("0 * * * *", "hourly") });
    const { schedules, failures } = await loadSchedules(dir);
    expect(schedules.map((s) => s.name)).toEqual(["ok"]); // the good one still loads
    expect(failures.find((f) => f.label.includes("bad"))?.message).toMatch(/invalid cron/);
  });

  it("carries logReply through, and refuses a non-boolean instead of coercing it", async () => {
    // `logReply: "false"` is truthy: coercing it would publish the reply of a schedule whose author meant to keep
    // it out of the logs, which is the one mistake the option exists to prevent.
    const quiet = `import { defineSchedule } from ${JSON.stringify(scheduleHref)};\nexport default defineSchedule({ cron: "0 * * * *", prompt: "go", logReply: false });\n`;
    const dir = await ws({ "quiet.ts": quiet, "typo.ts": quiet.replace("logReply: false", 'logReply: "false"') });
    const { schedules, failures } = await loadSchedules(dir);
    expect(schedules).toEqual([{ name: "quiet", cron: "0 * * * *", tz: undefined, prompt: "go", logReply: false }]);
    expect(failures.find((f) => f.label.includes("typo"))?.message).toMatch(/logReply must be a boolean/);
  });

  it("isolates a non-schedule default export", async () => {
    const dir = await ws({ "x.ts": "export default { nope: true };\n" });
    const { schedules, failures } = await loadSchedules(dir);
    expect(schedules).toEqual([]);
    expect(failures[0]?.message).toMatch(/must default-export defineSchedule/);
  });

  it("refuses only names that could leave the claims directory — a legal filename is a legal schedule", async () => {
    // The name becomes a path segment under `claims/`, so that is the whole rule. Narrowing it further would make an
    // ordinary filename load into nothing but one warning, and its schedule would silently stop firing.
    const dir = await ws({
      "...ts": def("0 * * * *"),
      "每日简报.ts": def("0 * * * *"),
      "my report.ts": def("0 * * * *"),
    });
    const { schedules, failures } = await loadSchedules(dir);
    expect(schedules.map((s) => s.name).sort()).toEqual(["my report", "每日简报"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/cannot be "\.", "\.\." or contain a path separator/);
  });

  it("a missing schedules/ dir yields empty (no schedules is normal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sd-empty-"));
    expect((await loadSchedules(dir)).schedules).toEqual([]);
  });
});
