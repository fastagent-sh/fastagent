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
const REMOVE_AT_MINOR = 17; // 0.15 introduced the participant model; 0.16 carries the migrations

describe("one-release migrations", () => {
  it("are deleted before the release that no longer needs them", () => {
    const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
    const [major, minor] = version.split(".").map(Number);
    expect(
      major === 0 && (minor ?? 0) < REMOVE_AT_MINOR,
      `v${version}: remove the participant-model migrations — the owned-threads.json cleanups in ` +
        "channels/feishu/feishu.ts + channels/slack/slack.ts, the `:root:` bucket filter in " +
        "channels/feishu/context-buffer.ts, and the `isLivePlaceKey` option it added to " +
        "channels/context-buffer.ts (drop the option if nothing else uses it). Then delete this test.",
    ).toBe(true);
  });
});
