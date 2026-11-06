/**
 * What setting up a channel's platform app asks of a person (channel-setup.md §2): the values only they have, where
 * to find each one, and how to tell a wrong one from a right one before it is kept. A channel's own module says it
 * (`channels/<kind>/setup.ts`); `cli/channel-setup.ts` asks, in a terminal or on a page, and writes what is accepted.
 */

/** How a channel receives (SPEC.md §8): which values its app needs depends on it. */
export type SetupWay = "webhook" | "connection";

/** Where a value is found: what to do, and the page to do it on. */
export interface SetupGuide {
  instructions: string;
  url?: string;
}

/** A value the person pastes. */
export interface PastedValue {
  kind: "paste";
  /** The variable it is kept in. */
  name: string;
  /** What the platform calls it, so the person need not map one name to another. */
  label: string;
  guide: SetupGuide;
  /**
   * Confirm `value` with the platform. Resolves with a note on what it is ("bot @acme_bot"), throws {@link
   * SetupRefused} for a value the platform refuses, and any other error for a check that could not be made (the
   * network, the platform down), which ends the setup instead of re-asking for a value that may be right.
   */
  check(value: string): Promise<string | undefined>;
}

/** A value setup makes itself. */
interface MadeValue {
  kind: "make";
  name: string;
  make(): string;
}

export type SetupValue = PastedValue | MadeValue;

/** What a channel needs to say its values: facts about the instance it is set up for. */
interface SetupContext {
  way: SetupWay;
  /** A name for an app created for it (the agent's directory). */
  appName: string;
  /** Where the platform will reach it, when the configuration names one. */
  publicUrl?: string;
}

/** What a channel's setup asks for, in order, and what is left to the person once it is done. */
interface SetupPlan {
  values: SetupValue[];
  after: string[];
}

export type ChannelSetup = (context: SetupContext) => SetupPlan;

/**
 * A pasted value the platform refuses. `fix` is what to do about it; `why` is the platform's own words, for someone
 * who has to look it up.
 */
export class SetupRefused extends Error {
  readonly fix: string | undefined;
  readonly why: string | undefined;
  constructor(headline: string, options: { fix?: string; why?: string } = {}) {
    super(headline);
    this.name = "SetupRefused";
    this.fix = options.fix;
    this.why = options.why;
  }
}
