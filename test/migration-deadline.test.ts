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
    const [major, minor] = version.split(".").map(Number);
    expect(
      major === 0 && (minor ?? 0) < REMOVE_AT_MINOR,
      `v${version}: CONFIRM the participant model shipped in 0.16 (re-pin REMOVE_AT_MINOR if not), then ` +
        "remove its migrations — the owned-threads.json cleanups in " +
        "channels/feishu/feishu.ts + channels/slack/slack.ts, and dropRetiredBuckets in " +
        "channels/feishu/context-buffer.ts. Then delete this test.",
    ).toBe(true);
  });
});
