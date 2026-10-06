/**
 * WHAT FORBIDS SCALING TO ZERO — one rule, read by every host that can scale.
 *
 * A host may only phrase its own REMEDY — the setting it owns (`min_machines_running`, App Sleeping) — never
 * re-derive the reason.
 *
 * A schedule is the agent's own clock: it keeps one machine up, and nothing here offers a way around that. Scaling to
 * zero with timed work means not declaring the schedule and keeping the time elsewhere (docs/deploy.md), never both.
 *
 * A WAKE-UP IS NOT A REASON. Every serve mounts `wake`, so counting it would pin every deployment up. It does not
 * need to: the wake-up store is on the volume and the poll drains what is due when the process starts, so a box that
 * slept fires it late, when a request next wakes it — never loses it. {@link WAKEUPS_WHEN_ASLEEP} says so where
 * scaling to zero is offered.
 */
import type { DeclaredChannel } from "../channels/discover.ts";

/** Why one machine has to stay up. Also the order they are checked in. */
type ResidencyReason = "long-connection" | "cron";

export interface Residency {
  reason: ResidencyReason;
  /** The host-neutral cause, one clause, for a generated comment or a runbook line. */
  why: string;
}

/** What scaling to zero costs the agent's own wake-ups — said next to every setting that allows it. */
export const WAKEUPS_WHEN_ASLEEP =
  "the agent's own wake-ups then fire when a request next wakes the machine, not on time";

/** What forbids scale-to-zero for this deployment, or `undefined` when nothing does. */
export function residencyFor(facts: {
  channels: readonly DeclaredChannel[];
  /** `schedules/` declares at least one schedule. */
  hasCron: boolean;
}): Residency | undefined {
  if (facts.channels.some((channel) => channel.ingress === "long-connection")) {
    return {
      reason: "long-connection",
      why: "a long-connection channel must stay connected — it cannot wake from zero",
    };
  }
  if (facts.hasCron) {
    return {
      reason: "cron",
      why: "a cron instant has no external wake-up here, so a sleeping box sleeps through it",
    };
  }
  return undefined;
}
