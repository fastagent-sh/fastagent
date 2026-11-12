/**
 * What setting up a channel's platform app asks of a person: the values only they have, where
 * to find each one, and how to tell a wrong one from a right one before it is kept. A channel's own module says it
 * (`channels/<kind>/setup.ts`); `cli/channel-setup.ts` asks, in a terminal or on a page, and writes what is accepted.
 */

/** How a channel receives: which values its app needs depends on it. */
export type SetupWay = "webhook" | "connection";

/** Where a value is found: what to do, and the page to do it on. */
export interface SetupGuide {
  instructions: string;
  url?: string;
}

/** The values of this setup so far: what the value file held and what each step has since kept. */
export type HeldValues = ReadonlyMap<string, string>;

/** One variable a pasted step asks for. */
interface PasteField {
  name: string;
  /** What the platform calls it, so the person need not map one name to another. */
  label: string;
  /** Whether it is hidden as typed; every value is unless it is only an identifier (default true). */
  secret?: boolean;
}

/**
 * Values the person pastes: one step, its fields asked together and checked together (a Lark App ID is only right
 * with its Secret).
 */
export interface PastedValues {
  kind: "paste";
  /** What the step is called on a page: "Bot User OAuth Token". */
  label: string;
  /** Where to find them; a function when the page depends on what an earlier step kept (an app's own console page). */
  guide: SetupGuide | ((held: HeldValues) => SetupGuide);
  fields: PasteField[];
  /**
   * Confirm `values` with the platform. Resolves with a note on what they are ("bot @acme_bot"), throws {@link
   * SetupRefused} for values the platform refuses, and any other error for a check that could not be made (the
   * network, the platform down), which ends the setup instead of re-asking for a value that may be right.
   */
  check(values: Record<string, string>): Promise<string | undefined>;
  /**
   * A way to get the value without asking (one field only): tried first, and the person is asked only when it
   * resolves undefined, having said why. Not tried for a value that is already held.
   */
  capture?(held: HeldValues): Promise<string | undefined>;
}

/** One pasted variable, checked on its own. */
export function pasteOne(input: {
  name: string;
  label: string;
  secret?: boolean;
  guide: PastedValues["guide"];
  check(value: string): Promise<string | undefined>;
  capture?: PastedValues["capture"];
}): PastedValues {
  const { name, label, secret, guide, check, capture } = input;
  return {
    kind: "paste",
    label,
    guide,
    fields: [{ name, label, ...(secret === undefined ? {} : { secret }) }],
    check: (values) => check(values[name] as string),
    ...(capture === undefined ? {} : { capture }),
  };
}

/** Values the platform makes when an app is created, which setup makes happen: all of them, or none. */
interface CreatedValues {
  kind: "create";
  names: string[];
  /** Create the app. `person` takes the step only they can (confirming it in the platform's own app). */
  create(person: SetupPerson): Promise<Record<string, string>>;
}

/** What a creation waits on a person for; the parts of a `cli/person.ts` Person it uses. */
interface SetupPerson {
  waitsOn(url: string, instructions: string, until?: number): void;
  carriesOn(): void;
}

/** A value setup makes itself. */
interface MadeValue {
  kind: "make";
  name: string;
  make(): string;
}

export type SetupValue = PastedValues | CreatedValues | MadeValue;

/** What a channel needs to say its values: facts about the instance it is set up for. */
interface SetupContext {
  way: SetupWay;
  /** A name for an app created for it (the agent's directory). */
  appName: string;
  /** Whether it is the development instance. */
  dev: boolean;
  /** Where the platform will reach it, when the configuration names one. */
  publicUrl?: string;
  /** The command that runs this setup again, for what a person is told to do before it. */
  rerun: string;
  /** A public URL for a local port, for a setup the platform must reach while it runs (a challenge to answer). */
  startTunnel(port: number): Promise<{ url: string; close(): void } | undefined>;
}

/**
 * What a channel's setup asks for, in order, and what is left to the person once it is done (`finish`, told every
 * value the instance now holds: what is left can depend on what the platform said about the app).
 */
interface SetupPlan {
  values: SetupValue[];
  finish(held: HeldValues): Promise<string[]> | string[];
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
