import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One-release migrations are invisible debt: each is correct today, none has an owner, and a comment
 * saying "remove after the next release" is not a thing that fires. This is the thing that fires.
 *
 * When this fails, delete the migrations it names (they are marked `REMOVE THIS` in the source) and
 * this file with them — by that release no live deployment can still be carrying the state files they
 * clean up.
 */
// Set on the ASSUMPTION that the participant model ships as 0.16, so 0.17 still carries the
// migrations. The release PR that actually ships it should re-pin this to `shipping minor + 2` — if
// another feature releases first, deleting on this schedule would strand a deployment upgrading from
// the release that introduced them.
const REMOVE_AT_MINOR = 18;

describe("one-release migrations", () => {
  it("are deleted before the release that no longer needs them", () => {
    const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
    const [major = 0, minor = 0] = version.split(".").map(Number);
    // Ordered, not `major === 0 && minor < N`: that reads a 1.0.0 as "deadline passed" for the wrong
    // reason and would fire with the same message whatever the minor happened to be.
    const due = major > 0 || minor >= REMOVE_AT_MINOR;
    expect(
      !due,
      `v${version}: CONFIRM the participant model shipped in 0.16 (re-pin REMOVE_AT_MINOR if not), then ` +
        "remove the removeRetiredStateFile('owned-threads.json') calls in channels/feishu/feishu.ts + " +
        "channels/slack/slack.ts (and the helper itself if nothing else uses it), " +
        "and delete this test. NOT dropRetiredBuckets in channels/feishu/context-buffer.ts — that one is " +
        "permanent on purpose (it is what stops retired buckets holding chat content, and a version-" +
        "skipping upgrade would never run an expired copy of it).",
    ).toBe(true);
  });
});
