import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSchedules } from "../src/schedule/discover.ts";

const md = (frontmatter: string, prompt = "go"): string => `---\n${frontmatter}\n---\n\n${prompt}\n`;

async function ws(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-sd-"));
  await mkdir(join(dir, "schedules"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, "schedules", name), content);
  return dir;
}

describe("schedule/discover", () => {
  it("loads schedules/<name>.md: the frontmatter's cron and tz, the body as the prompt", async () => {
    const dir = await ws({
      "daily.md": md('cron: "0 9 * * 1-5"\ntz: Asia/Shanghai', "Summarize yesterday.\n\nPost it to #team."),
      // A bare cron starting with `*` is what an author types; YAML would read it as an alias.
      "often.md": md("# every fifteen minutes\ncron: */15 * * * *"),
      "notes.txt": "not a schedule", // only *.md files are schedules
    });
    const { schedules, failures } = await loadSchedules(dir);
    expect(failures).toEqual([]);
    expect(schedules).toEqual([
      { name: "daily", cron: "0 9 * * 1-5", tz: "Asia/Shanghai", prompt: "Summarize yesterday.\n\nPost it to #team." },
      { name: "often", cron: "*/15 * * * *", prompt: "go" },
    ]);
  });

  it("refuses, naming the file, whatever is not exactly a schedule; the valid ones still load", async () => {
    const dir = await ws({
      "ok.md": md('cron: "0 * * * *"'),
      "no-front.md": "just a prompt\n",
      "unclosed.md": '---\ncron: "0 * * * *"\nprompt\n',
      "no-cron.md": md("tz: UTC"),
      "bad-cron.md": md("cron: not a cron"),
      // The floor a recurring wake-up is held to: the agent writes these files too.
      "frequent.md": md('cron: "*/5 * * * *"'),
      "per-second.md": md('cron: "* * * * * *"'),
      "bad-tz.md": md('cron: "0 * * * *"\ntz: Mars/Olympus'),
      "unknown-key.md": md('cron: "0 * * * *"\nsession: mine'),
      "twice.md": md('cron: "0 * * * *"\ncron: "0 1 * * *"'),
      "not-kv.md": md('cron: "0 * * * *"\n- a list item'),
      "empty.md": md('cron: "0 * * * *"', ""),
    });
    const { schedules, failures } = await loadSchedules(dir);
    expect(schedules.map((s) => s.name)).toEqual(["ok"]);
    const why = Object.fromEntries(failures.map((f) => [f.label, f.message]));
    expect(why).toEqual({
      "schedules/bad-cron.md": expect.stringMatching(/^invalid cron\/tz/),
      "schedules/bad-tz.md": expect.stringMatching(/unknown timezone "Mars\/Olympus"/),
      "schedules/empty.md": expect.stringMatching(/has no prompt/),
      "schedules/frequent.md": expect.stringMatching(/too frequent — it must fire at most every 10 minutes/),
      "schedules/per-second.md": expect.stringMatching(/too frequent/),
      "schedules/no-cron.md": expect.stringMatching(/needs a "cron"/),
      "schedules/no-front.md": expect.stringMatching(/must start with a "---" frontmatter/),
      "schedules/not-kv.md": expect.stringMatching(/is not "key: value"/),
      "schedules/twice.md": expect.stringMatching(/"cron" appears twice/),
      "schedules/unclosed.md": expect.stringMatching(/no closing "---"/),
      "schedules/unknown-key.md": expect.stringMatching(/unknown frontmatter key "session"/),
    });
  });

  it("refuses only names that could leave the claims directory — a legal filename is a legal schedule", async () => {
    // The name becomes a path segment under `claims/`, so that is the whole rule. Narrowing it further would make an
    // ordinary filename load into nothing, and its schedule would silently stop firing.
    const dir = await ws({
      "..md": md('cron: "0 * * * *"'),
      "每日简报.md": md('cron: "0 * * * *"'),
      "my report.md": md('cron: "0 * * * *"'),
    });
    const { schedules, failures } = await loadSchedules(dir);
    expect(schedules.map((s) => s.name).sort()).toEqual(["my report", "每日简报"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toMatch(/cannot be empty, "\.", "\.\." or contain a path separator/);
  });

  it("arms at most 20, the first by name, and names each one left out", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 22 }, (_, i) => [`s${String(i).padStart(2, "0")}.md`, md('cron: "0 * * * *"')]),
    );
    const { schedules, failures } = await loadSchedules(await ws(files));
    expect(schedules.map((s) => s.name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(2, "0")}`),
    );
    expect(failures.map((f) => [f.label, f.message])).toEqual([
      ["schedules/s20.md", expect.stringMatching(/^more than 20 schedules/)],
      ["schedules/s21.md", expect.stringMatching(/^more than 20 schedules/)],
    ]);
  });

  it("a missing schedules/ dir yields none (no schedules is normal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-sd-empty-"));
    expect(await loadSchedules(dir)).toEqual({ schedules: [], failures: [] });
  });
});
