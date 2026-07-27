import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One-release migrations are invisible debt: each is correct today, none has an owner, and a comment
 * saying "remove after the next release" is not a thing that fires. This is the thing that fires.
 *
 * The deadline is DERIVED from a fact already known when the migrations were written — the last
 * released version at the time — rather than promised to a future release step. A deadline that needs
 * a human to arm it is the unowned comment it was meant to replace, and it fails silently by passing.
 */
const LAST_RELEASED_MINOR = 15;

/** `package.json`'s minor is the release already CUT, so code on this branch reaches users one later. */
const SHIPS_IN_MINOR = LAST_RELEASED_MINOR + 1;

/** Minors the migrations must survive, counted from the one that ships them. Two, so a deployment
 *  running the release that first shipped them still finds the cleanup when it upgrades. Skipping
 *  several releases at once is not covered here and never was — that is why only INERT leftovers
 *  expire, and why the cleanup that would otherwise leave chat content on disk (dropRetiredBuckets) is
 *  permanent instead. */
const GRACE_MINORS = 2;

describe("one-release migrations", () => {
  it("are deleted before the release that no longer needs them", () => {
    const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
    const [major = 0, minor = 0] = version.split(".").map(Number);
    // Ordered, not `major === 0 && minor < N`: that reads a 1.0.0 as "deadline passed" for the wrong
    // reason and would fire with the same message whatever the minor happened to be.
    const due = major > 0 || minor >= SHIPS_IN_MINOR + GRACE_MINORS;
    expect(
      !due,
      `v${version}: the participant model's migrations shipped in 0.${SHIPS_IN_MINOR} and are now due ` +
        "for removal — the removeRetiredStateFile('owned-threads.json') calls in " +
        "channels/feishu/feishu.ts + channels/slack/slack.ts (and the helper itself if nothing else " +
        "uses it), and this test. NOT dropRetiredBuckets in channels/feishu/context-buffer.ts — that " +
        "one is permanent on purpose (it is what stops retired buckets holding chat content, and a " +
        "version-skipping upgrade would never run an expired copy of it).",
    ).toBe(true);
  });
});
