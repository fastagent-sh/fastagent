import { describe, expect, it } from "vitest";
import type { DeclaredChannel } from "../src/channels/discover.ts";
import { residencyFor } from "../src/deploy/residency.ts";

/**
 * "What forbids scaling to zero" — the rule, tested where it lives. Fly's `min_machines_running`
 * comment, Railway's App-Sleeping runbook line and Fly's kept-file gate are three readers of it; their
 * own tests owe the SETTING each one writes, not this table.
 */

const channel = (name: string, ingress: DeclaredChannel["ingress"] = "webhook"): DeclaredChannel =>
  ({ name, ingress }) as DeclaredChannel;

const nothing = { channels: [], hasCron: false };

describe("deploy/residency", () => {
  it("is undefined when nothing in the definition needs a machine up", () => {
    expect(residencyFor(nothing)).toBeUndefined();
    expect(residencyFor({ ...nothing, channels: [channel("telegram")] })).toBeUndefined();
  });

  it("reports each reason with the cause, not the remedy", () => {
    // The remedy is the host's word (`min_machines_running`, App Sleeping); the CAUSE is this rule's,
    // and it is why two hosts could not drift apart on it again.
    expect(residencyFor({ ...nothing, hasCron: true })).toMatchObject({ reason: "cron" });
    expect(residencyFor({ ...nothing, channels: [channel("socket", "long-connection")] })).toMatchObject({
      reason: "long-connection",
    });
    for (const facts of [{ ...nothing, hasCron: true }]) {
      expect(residencyFor(facts)?.why).not.toMatch(/min_machines_running|App Sleeping/);
    }
  });

  it("with both, the long connection is the reason reported", () => {
    expect(residencyFor({ ...nothing, hasCron: true, channels: [channel("socket", "long-connection")] })?.reason).toBe(
      "long-connection",
    );
  });
});
