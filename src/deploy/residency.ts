/**
 * WHAT FORBIDS SCALING TO ZERO — one rule, read by every host that can scale.
 *
 * It was spelled twice: Fly's `min_machines_running` comment and Railway's App-Sleeping runbook line each carried
 * the same three conditions in the same order with different words, and the words had already drifted (one said
 * "no external wake-up for a cron instant", the other "a sleeping service sleeps through them"). A host may only
 * phrase its own REMEDY — the setting it owns — never re-derive the reason.
 *
 * ORDER IS THE POINT, not just precedence: the reason reported has to be the one an operator cannot work around,
 * because the message it produces differs. A runtime-minted wake-up has no substitute at all; a
 * declared schedule has one, because the clock does not have to be ours — see {@link CRON_CAN_BE_EXTERNAL}.
 */
import type { DeclaredChannel } from "../channels/discover.ts";

/** Why one machine has to stay up. Also the order they are checked in. */
export type ResidencyReason = "wake-ups" | "cron" | "long-connection";

export interface Residency {
  reason: ResidencyReason;
  /** The host-neutral cause, one clause, for a generated comment or a runbook line. */
  why: string;
}

/**
 * The ONE reason a caller may offer a way out of: a cron is a TIME, and a time can be kept elsewhere — a platform
 * scheduler, a CI cron, a crontab — which then calls this agent. Nothing else here can be moved out: a wake-up is
 * minted by the agent at runtime inside its own state, so nothing outside can know to send it.
 */
export const CRON_CAN_BE_EXTERNAL: ResidencyReason = "cron";

/** What forbids scale-to-zero for this deployment, or `undefined` when nothing does. */
export function residencyFor(facts: {
  channels: readonly DeclaredChannel[];
  /** `routines/` declares at least one cron. */
  hasCron: boolean;
  /** The agent may schedule ITSELF (`selfSchedule`, the wake tool). */
  hasWakeups: boolean;
}): Residency | undefined {
  if (facts.hasWakeups) {
    return {
      reason: "wake-ups",
      why: "a self-scheduled wake-up is minted at runtime, so nothing outside this process can know to send it",
    };
  }
  if (facts.hasCron) {
    return {
      reason: "cron",
      why: "a cron instant has no external wake-up here, so a sleeping box sleeps through it",
    };
  }
  if (facts.channels.some((channel) => channel.ingress === "long-connection")) {
    return {
      reason: "long-connection",
      why: "a long-connection channel must stay connected — it cannot wake from zero",
    };
  }
  return undefined;
}
