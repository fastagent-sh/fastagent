/**
 * `openExternalUrl` obliges its callers, and nothing but this checks that they comply.
 *
 * The function swallows its spawn error on purpose — no browser on a server is normal — so a caller
 * that does not ALSO print the URL leaves a headless operator staring at a prompt with no way to
 * reach the page. Its own doc states the obligation; one of the six call sites had already lost it
 * (the Slack onboarding resume path, which then asks for a token from a page never shown).
 *
 * A TEXT scan, with the limits that implies. It reads what precedes each call, not what the program
 * does — `add-slack-replace-config.test.ts` carries the behavioural assertion for the fixed path.
 * This one exists for the call sites that have no test of their own, and for the seventh one nobody
 * has written yet.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Ways this codebase reaches the operator. `note()` is add-feishu's local helper (console.error
 *  underneath), `log.*` the leveled logger, `clackLog.*` the prompt library's. Missing one here
 *  fails CORRECT code, so the list is wide rather than tight. */
const OUTPUT = /console\.(?:error|log|warn|info)\(|clackLog\.\w+\(|\bnote\(|\blog\.\w+\(/;

/** The whole argument, not just an identifier: a call is as likely to inline the URL as to name it,
 *  and `\w+` silently skipped every one that did — the shape a new call site is MOST likely to take.
 *  The lookbehind drops the DECLARATION in open-url.ts, whose parameter list reads as a call. */
const CALL = /(?<!function\s)openExternalUrl\(\s*([^)]+?)\s*\)/;

/** What to look for in the preceding output: a string literal must appear by its CONTENT (the
 *  quotes are not printed), anything else by how it is written. */
function needle(argument: string): string {
  const literal = /^(["'`])(.*)\1$/.exec(argument);
  return literal ? (literal[2] as string) : argument;
}

describe("CLI output obligations", () => {
  it("every openExternalUrl call prints its URL first — the headless fallback it depends on", () => {
    const offenders: string[] = [];
    for (const file of sources(srcDir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const call = CALL.exec(line);
        if (!call) return;
        const argument = (call[1] as string).trim();
        const window = lines.slice(Math.max(0, i - 12), i).join("\n");
        const printed = window.search(OUTPUT);
        // A HEURISTIC, named as one: it asks that some output call precede the open and that the
        // argument appear after it. That catches the real miss — an open with nothing printed —
        // and tolerates an alias (`const u = url` under a print of `url`), which did print the URL.
        // What it cannot see is an output call printing an UNRELATED string near an open; proving
        // that needs an AST, and this guard does not earn one.
        if (printed === -1 || !window.slice(printed).includes(needle(argument))) {
          offenders.push(`${relative(srcDir, file)}:${i + 1} opens ${argument} without printing it`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
