import { describe, expect, it } from "vitest";
import type { DeclaredChannel } from "../src/channels/discover.ts";
import { CRON_CAN_BE_EXTERNAL, residencyFor } from "../src/deploy/residency.ts";

/**
 * "What forbids scaling to zero" — the rule, tested where it lives. Fly's `min_machines_running`
 * comment, Railway's App-Sleeping runbook line and Fly's kept-file gate are three readers of it; their
 * own tests owe the SETTING each one writes, not this table.
 */

const channel = (name: string, ingress: DeclaredChannel["ingress"] = "webhook"): DeclaredChannel =>
  ({ name, ingress }) as DeclaredChannel;

const nothing = { channels: [], hasCron: false, hasWakeups: false };

describe("deploy/residency", () => {
  it("is undefined when nothing in the definition needs a machine up", () => {
    expect(residencyFor(nothing)).toBeUndefined();
    expect(residencyFor({ ...nothing, channels: [channel("telegram")] })).toBeUndefined();
  });

  it("reports each reason with the cause, not the remedy", () => {
    // The remedy is the host's word (`min_machines_running`, App Sleeping); the CAUSE is this rule's,
    // and it is why two hosts could not drift apart on it again.
    expect(residencyFor({ ...nothing, channels: [channel("github")] })).toMatchObject({ reason: "github" });
    expect(residencyFor({ ...nothing, hasWakeups: true })).toMatchObject({ reason: "wake-ups" });
    expect(residencyFor({ ...nothing, hasCron: true })).toMatchObject({ reason: "cron" });
    expect(residencyFor({ ...nothing, channels: [channel("socket", "long-connection")] })).toMatchObject({
      reason: "long-connection",
    });
    for (const facts of [
      { ...nothing, channels: [channel("github")] },
      { ...nothing, hasWakeups: true },
      { ...nothing, hasCron: true },
    ]) {
      expect(residencyFor(facts)?.why).not.toMatch(/min_machines_running|App Sleeping/);
    }
  });

  it("reports the reason WITHOUT a way out first — the message depends on which one it is", () => {
    // A cron can be fired by someone else's clock through POST /run; a wake-up is minted by the
    // agent at runtime, so nothing outside can know to send it. Reporting the cron half of a
    // definition that has both would offer a way out that drops every wake-up.
    expect(residencyFor({ ...nothing, hasCron: true, hasWakeups: true })?.reason).toBe("wake-ups");
    expect(residencyFor({ ...nothing, hasCron: true, hasWakeups: true })?.reason).not.toBe(CRON_CAN_BE_EXTERNAL);
    // github outranks both: no replay at all, and a sleep mid-review loses the turn.
    expect(residencyFor({ channels: [channel("github")], hasCron: true, hasWakeups: true })?.reason).toBe("github");
    // A long connection is last only because the others are stronger, not because it is optional.
    expect(residencyFor({ ...nothing, hasCron: true, channels: [channel("socket", "long-connection")] })?.reason).toBe(
      "cron",
    );
  });

  it("names exactly one reason as externally replaceable", () => {
    // A guard on the constant itself: it decides whether a host prints "…or drive POST /run", and
    // pointing it at any other reason would publish advice that loses turns.
    expect(CRON_CAN_BE_EXTERNAL).toBe("cron");
  });
});
