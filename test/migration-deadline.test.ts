import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One-release migrations are invisible debt: each is correct today, none has an owner, and a comment
 * saying "remove after the next release" is not a thing that fires. This is the thing that fires.
 *
 * The deadline is derived from a RECORDED fact — which release introduced the migrations — rather than
 * from a guess embedded in a failure message. Getting that fact right is a release-time step
 * (AGENTS.md, release flow): while `SHIPPED_IN_MINOR` is still `undefined` the migrations are simply not due,
 * so a slipped release cannot expire them early.
 */
const SHIPPED_IN_MINOR: number | undefined = undefined; // set to the 0.x minor that ships the participant model

/** One full release must pass carrying the migrations, so a deployment upgrading from the release that
 *  introduced them still runs the cleanup. */
const GRACE_MINORS = 2;

describe("one-release migrations", () => {
  it("are deleted before the release that no longer needs them", () => {
    if (SHIPPED_IN_MINOR === undefined) return; // not released yet — nothing can be overdue
    const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
    const [major = 0, minor = 0] = version.split(".").map(Number);
    // Ordered, not `major === 0 && minor < N`: that reads a 1.0.0 as "deadline passed" for the wrong
    // reason and would fire with the same message whatever the minor happened to be.
    const due = major > 0 || minor >= SHIPPED_IN_MINOR + GRACE_MINORS;
    expect(
      !due,
      `v${version}: the participant model shipped in 0.${SHIPPED_IN_MINOR}, so its one-release migrations ` +
        "are due for removal — the removeRetiredStateFile('owned-threads.json') calls in " +
        "channels/feishu/feishu.ts + channels/slack/slack.ts (and the helper itself if nothing else " +
        "uses it), and this test. NOT dropRetiredBuckets in channels/feishu/context-buffer.ts — that " +
        "one is permanent on purpose (it is what stops retired buckets holding chat content, and a " +
        "version-skipping upgrade would never run an expired copy of it).",
    ).toBe(true);
  });
});
