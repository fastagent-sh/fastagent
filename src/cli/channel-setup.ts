/**
 * Setting up one channel's platform app for one instance (channel-setup.md §2): ask a person for the values only they
 * have, check each with the platform, and keep what is accepted in the instance's value file. Safe to run again: a value
 * already there that the platform still accepts is kept, one it refuses is asked for again, and a value setup makes
 * itself is made once.
 *
 * What differs per channel is in `channels/<kind>/setup.ts`; this is how they are asked: at a terminal, or, for a coding
 * agent that has none, on a page of this machine's (credentials-page.ts) that its person is sent to through a ticket.
 */
import { basename } from "node:path";
import { isCancel, log as clackLog, password } from "@clack/prompts";
import { slackSetup } from "../channels/slack/setup.ts";
import { type ChannelSetup, type PastedValue, SetupRefused, type SetupWay } from "../channels/setup.ts";
import { telegramSetup } from "../channels/telegram/setup.ts";
import { startCredentialsPage } from "../credentials-page.ts";
import { openExternalUrl } from "../open-url.ts";
import { loadEnvValues, unprotectedSecretsNote, writeValues } from "../value-file.ts";
import type { Person } from "./person.ts";

const SETUPS = { telegram: telegramSetup, slack: slackSetup } as const satisfies Record<string, ChannelSetup>;

/** The channels whose app this release sets up. */
export type SetupKind = keyof typeof SETUPS;

export const isSetupKind = (name: string): name is SetupKind => Object.hasOwn(SETUPS, name);

const say = (message: string): void => console.error(`[fastagent] ${message}`);

export interface SetUpChannelInput {
  kind: SetupKind;
  agentDir: string;
  /** The value file the credentials are kept in. */
  file: string;
  way: SetupWay;
  /** Where the platform will reach the instance, when its configuration names it. */
  publicUrl?: string;
  /** A coding agent's person, through a ticket: asked on a page. Absent: asked at this terminal. */
  person?: Person;
}

export interface SetUpOutcome {
  /** The variables this run wrote. */
  written: string[];
  /** The variables that were set already, and are accepted. */
  kept: string[];
  /** What is left to the person once it is done. */
  after: string[];
}

export async function setUpChannel(input: SetUpChannelInput): Promise<SetUpOutcome> {
  const { kind, agentDir, file, person } = input;
  const plan = SETUPS[kind]({
    way: input.way,
    appName: basename(agentDir),
    ...(input.publicUrl === undefined ? {} : { publicUrl: input.publicUrl }),
  });
  const written: string[] = [];
  const kept: string[] = [];
  /** A directory fastagent does not own that now holds a secret: said once, however many values went there. */
  let unprotected: string | undefined;

  const keep = async (name: string, value: string, replace: boolean): Promise<void> => {
    const result = await writeValues(agentDir, `${kind} channel`, [{ name, value }], replace ? [name] : [], file);
    unprotected ??= result.unprotectedSecretsDir;
    written.push(name);
  };

  const held = loadEnvValues(file);
  const toAsk: PastedValue[] = [];
  for (const value of plan.values) {
    const current = held.get(value.name)?.trim();
    if (value.kind === "make") {
      if (current) kept.push(value.name);
      else await keep(value.name, value.make(), false);
      continue;
    }
    if (current) {
      try {
        const note = await value.check(current);
        kept.push(value.name);
        say(`${value.name} is already set in ${file}${note ? ` (${note})` : ""} — keeping it`);
        continue;
      } catch (error) {
        if (!(error instanceof SetupRefused)) throw error;
        say(`${value.name} in ${file} is refused (${error.message}) — asking for another`);
      }
    }
    toAsk.push(value);
  }

  if (toAsk.length > 0) {
    const accept = async (value: PastedValue, pasted: string): Promise<void> => {
      const note = await value.check(pasted);
      await keep(value.name, pasted, true);
      say(`${value.name} saved to ${file}${note ? ` (${note})` : ""}`);
    };
    if (person === undefined) await askAtTerminal(toAsk, accept);
    else await askOnPage(kind, toAsk, accept, person);
  }
  if (unprotected !== undefined)
    say(`note: ${unprotectedSecretsNote(unprotected, "where this instance keeps its values")}`);
  return { written, kept, after: plan.after };
}

async function askAtTerminal(
  values: readonly PastedValue[],
  accept: (value: PastedValue, pasted: string) => Promise<void>,
): Promise<void> {
  for (const value of values) {
    clackLog.info(value.guide.instructions);
    if (value.guide.url !== undefined) {
      say(`opening ${value.guide.url}`);
      openExternalUrl(value.guide.url);
    }
    for (;;) {
      const answer = await password({ message: value.label });
      if (isCancel(answer)) throw new Error("setup cancelled");
      const pasted = String(answer).trim();
      if (pasted === "") {
        clackLog.error(`${value.label} is needed.`);
        continue;
      }
      try {
        await accept(value, pasted);
        break;
      } catch (error) {
        if (!(error instanceof SetupRefused)) throw error;
        clackLog.error(`${error.message}${error.fix === undefined ? "" : ` ${error.fix}`}`);
      }
    }
  }
}

async function askOnPage(
  kind: SetupKind,
  values: readonly PastedValue[],
  accept: (value: PastedValue, pasted: string) => Promise<void>,
  person: Person,
): Promise<void> {
  const named = new Map(values.map((value) => [value.name, value]));
  const product = kind === "slack" ? "Slack" : "Telegram";
  const page = await startCredentialsPage({
    title: `Connect ${product}`,
    doneHeading: `${product} connected`,
    fields: values.map(({ name, label, guide }) => ({ name, label, guide })),
    accept: (name, pasted) => accept(named.get(name) as PastedValue, pasted),
  });
  try {
    person.waitsOn(page.url, `paste ${values.map((value) => value.label).join(" and ")} on this page`);
    await page.done;
    person.carriesOn();
  } finally {
    await page.close();
  }
}
