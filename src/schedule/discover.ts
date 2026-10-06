/**
 * Schedule discovery: `schedules/<name>.md`, each a frontmatter (`cron`, optional `tz`) over the prompt.
 *
 * The frontmatter is read STRICTLY rather than as YAML: two keys whose values are one line each, and a cron written
 * bare, starting with `*`, is what an author types even though YAML reads a leading `*` as an alias. Anything else in it —
 * an unknown key, a line that is not `key: value`, a key twice — is refused naming the file, never guessed at.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModuleLoadFailure } from "../loader.ts";
import { assertInsideAgentDir } from "../paths.ts";
import { recurringCronError } from "./cron.ts";
import type { Schedule } from "./schedule.ts";
import { isSafeScheduleName } from "./state.ts";
import { MAX_PENDING_WAKEUPS } from "./wakeups.ts";

/** As many schedules as one conversation may have pending wake-ups: the same bound on what the agent can set going. */
export const MAX_SCHEDULES = MAX_PENDING_WAKEUPS;

/**
 * THE cap on what is armed: at most {@link MAX_SCHEDULES}, the first by name; `over` is the rest. It applies to the
 * armed SET (the scheduler passes the valid files and the old definitions it keeps for broken ones, together), not to
 * the files that loaded: a cap counted over valid files alone is passed by every file that breaks and is kept.
 */
export function capSchedules(schedules: readonly Schedule[]): { within: Schedule[]; over: Schedule[] } {
  const sorted = [...schedules].sort((a, b) => a.name.localeCompare(b.name));
  return { within: sorted.slice(0, MAX_SCHEDULES), over: sorted.slice(MAX_SCHEDULES) };
}

const KEYS = new Set(["cron", "tz"]);

/** The frontmatter's keys and the body under it, or why the file is not a schedule. */
function parse(text: string): { fields: Map<string, string>; body: string } | { error: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { error: 'it must start with a "---" frontmatter line holding its cron' };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return { error: 'its frontmatter has no closing "---" line' };
  const fields = new Map<string, string>();
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) return { error: `frontmatter line ${JSON.stringify(line)} is not "key: value"` };
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (!KEYS.has(key)) return { error: `unknown frontmatter key "${key}" (a schedule has "cron" and "tz")` };
    if (fields.has(key)) return { error: `frontmatter key "${key}" appears twice` };
    const quoted = /^(["'])(.*)\1$/.exec(rawValue);
    fields.set(key, quoted ? (quoted[2] as string) : rawValue);
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** Discover the schedules in `<dir>/schedules/`, sorted by name. A file that is not a valid schedule is a failure. */
export async function loadSchedules(dir: string): Promise<{ schedules: Schedule[]; failures: ModuleLoadFailure[] }> {
  await assertInsideAgentDir(dir, "schedules");
  const scheduleDir = join(dir, "schedules");
  let dirents: Dirent[];
  try {
    dirents = await readdir(scheduleDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schedules: [], failures: [] };
    throw new Error(`cannot read ${scheduleDir}: ${(error as Error).message}`);
  }
  const schedules: Schedule[] = [];
  const failures: ModuleLoadFailure[] = [];
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.name.endsWith(".md")) continue;
    const label = `schedules/${dirent.name}`;
    const file = join(scheduleDir, dirent.name);
    const fail = (message: string) => failures.push({ label, file, message });
    if (!dirent.isFile()) {
      // A failure like any other, so a re-read reports it once rather than on every pass.
      fail("it is not a regular file — schedules must be real files inside the agent dir");
      continue;
    }
    const name = dirent.name.slice(0, -".md".length);
    // The name becomes a path segment (the fired-slot claims live under `claims/<name>/`).
    if (!isSafeScheduleName(name)) {
      fail('a schedule name cannot be empty, ".", ".." or contain a path separator');
      continue;
    }
    const parsed = parse(await readFile(file, "utf8"));
    if ("error" in parsed) {
      fail(parsed.error);
      continue;
    }
    const cron = parsed.fields.get("cron");
    const tz = parsed.fields.get("tz");
    if (cron === undefined || cron === "") {
      fail('its frontmatter needs a "cron" (e.g. cron: "0 9 * * 1-5")');
      continue;
    }
    // The same guard a recurring wake-up passes: the agent writes these files too.
    const invalid = recurringCronError(cron, tz);
    if (invalid) {
      fail(invalid);
      continue;
    }
    if (parsed.body === "") {
      fail("it has no prompt: write what the agent should do under the frontmatter");
      continue;
    }
    schedules.push({ name, cron, ...(tz !== undefined ? { tz } : {}), prompt: parsed.body });
  }
  return { schedules, failures };
}
