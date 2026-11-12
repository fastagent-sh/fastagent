import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNSORTED } from "./tiers.ts";

const TEST_DIR = new URL(".", import.meta.url).pathname;

/** How long something took (the clock read minus a start), which load decides as much as the code does. */
const ELAPSED = /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$]/;

/** Files that still assert elapsed time, to be moved to a fake clock or an injected timeout. The list only shrinks. */
const ASSERTS_ELAPSED = [
  "agent-api-conformance.ts",
  "feishu.test.ts",
  "http-api.test.ts",
  "instance-name.test.ts",
  "preview.test.ts",
  "serve-routes.test.ts",
  "service.test.ts",
  "slack-preview.test.ts",
  "strip-edges.test.ts",
  "telegram-api.test.ts",
  "telegram.test.ts",
  "ticket.test.ts",
];

const files = readdirSync(TEST_DIR).filter((file) => file.endsWith(".ts"));

describe('the test tiers (CONTRIBUTING.md, "Test tiers")', () => {
  it("lists only files that exist, and no test asserts elapsed time beyond its list", () => {
    const stale = [...UNSORTED, ...ASSERTS_ELAPSED].filter((file) => !existsSync(`${TEST_DIR}${file}`));
    const timed = files.filter((file) => ELAPSED.test(readFileSync(`${TEST_DIR}${file}`, "utf8")));
    expect({ stale, unlisted: timed.filter((file) => !ASSERTS_ELAPSED.includes(file)) }).toEqual({
      stale: [],
      unlisted: [],
    });
    expect(
      ASSERTS_ELAPSED.filter((file) => !timed.includes(file)),
      "no longer asserts elapsed time: unlist it",
    ).toEqual([]);
  });
});
