/**
 * WHAT FORBIDS SCALING TO ZERO — one rule, read by every host that can scale.
 *
 * A host may only phrase its own REMEDY — the setting it owns (`min_machines_running`, App Sleeping) — never
 * re-derive the reason.
 *
 * ORDER IS THE POINT, not just precedence: the reason reported has to be the one an operator cannot work around,
 * because the message it produces differs. A declared schedule has a substitute, because the clock does not have to
 * be ours — see {@link CRON_CAN_BE_EXTERNAL}; a long connection has none.
 *
 * A WAKE-UP IS NOT A REASON. Every serve mounts `wake`, so counting it would pin every deployment up. It does not
 * need to: the wake-up store is on the volume and the poll drains what is due when the process starts, so a box that
 * slept fires it late, when a request next wakes it — never loses it. {@link WAKEUPS_WHEN_ASLEEP} says so where
 * scaling to zero is offered.
 */
import type { DeclaredChannel } from "../channels/discover.ts";

/** Why one machine has to stay up. Also the order they are checked in. */
export type ResidencyReason = "long-connection" | "cron";

export interface Residency {
  reason: ResidencyReason;
  /** The host-neutral cause, one clause, for a generated comment or a runbook line. */
  why: string;
}

/**
 * The ONE reason a caller may offer a way out of: a cron is a TIME, and a time can be kept elsewhere — a platform
 * scheduler, a CI cron, a crontab — which then calls this agent. Nothing else here can be moved out: a long
 * connection is one this process holds.
 */
export const CRON_CAN_BE_EXTERNAL: ResidencyReason = "cron";

/** What scaling to zero costs the agent's own wake-ups — said next to every setting that allows it. */
export const WAKEUPS_WHEN_ASLEEP =
  "the agent's own wake-ups then fire when a request next wakes the machine, not on time";

/** What forbids scale-to-zero for this deployment, or `undefined` when nothing does. */
export function residencyFor(facts: {
  channels: readonly DeclaredChannel[];
  /** `routines/` declares at least one cron. */
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
