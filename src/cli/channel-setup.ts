/**
 * Setting up one channel's platform app for one instance: ask a person for the values only they
 * have, check each with the platform, and keep what is accepted in the instance's value file. Safe to run again: a value
 * already there that the platform still accepts is kept, one it refuses is asked for again, a value setup makes itself
 * is made once, and an app already created is not created again.
 *
 * What differs per channel is in `channels/<kind>/setup.ts`; this is how they are asked: at a terminal, or, for a coding
 * agent that has none, on a page of this machine's (credentials-page.ts) that its person is sent to through a ticket.
 */
import { basename } from "node:path";
import { isCancel, log as clackLog, password, text } from "@clack/prompts";
import { feishuSetup } from "../channels/feishu/setup.ts";
import { larkSetup } from "../channels/lark/setup.ts";
import { slackSetup } from "../channels/slack/setup.ts";
import {
  type ChannelSetup,
  type HeldValues,
  type PastedValues,
  SetupRefused,
  type SetupGuide,
  type SetupWay,
} from "../channels/setup.ts";
import { telegramSetup } from "../channels/telegram/setup.ts";
import { startCredentialsPage } from "../credentials-page.ts";
import { openExternalUrl } from "../open-url.ts";
import { startCloudflareTunnel } from "../tunnel.ts";
import { loadEnvValues, trackedValueFileNote, unprotectedSecretsNote, writeValues } from "../value-file.ts";
import { type Person, terminalPerson } from "./person.ts";

const SETUPS = {
  telegram: telegramSetup,
  slack: slackSetup,
  feishu: feishuSetup,
  lark: larkSetup,
} as const satisfies Record<string, ChannelSetup>;

const PRODUCTS: Record<SetupKind, string> = { telegram: "Telegram", slack: "Slack", feishu: "Feishu", lark: "Lark" };

/** The channels whose app `channels setup` sets up. */
export type SetupKind = keyof typeof SETUPS;

export const isSetupKind = (name: string): name is SetupKind => Object.hasOwn(SETUPS, name);

const say = (message: string): void => console.error(`[fastagent] ${message}`);

export interface SetUpChannelInput {
  kind: SetupKind;
  agentDir: string;
  /** The value file the credentials are kept in. */
  file: string;
  way: SetupWay;
  /** Whether this is the development instance. */
  dev: boolean;
  /** The command that runs this setup again. */
  rerun: string;
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

/** The variables a channel's app needs for `way`, in the order setup asks for them. */
export function setupNames(kind: SetupKind, way: SetupWay): string[] {
  const plan = SETUPS[kind]({ way, appName: "", dev: true, rerun: "", startTunnel: startCloudflareTunnel });
  return plan.values.flatMap((value) =>
    value.kind === "paste" ? value.fields.map((one) => one.name) : value.kind === "create" ? value.names : [value.name],
  );
}

export async function setUpChannel(input: SetUpChannelInput): Promise<SetUpOutcome> {
  const { kind, agentDir, file, person } = input;
  const plan = SETUPS[kind]({
    way: input.way,
    appName: basename(agentDir),
    dev: input.dev,
    rerun: input.rerun,
    startTunnel: startCloudflareTunnel,
    ...(input.publicUrl === undefined ? {} : { publicUrl: input.publicUrl }),
  });
  const written: string[] = [];
  const kept: string[] = [];
  /** A directory fastagent does not own that now holds a secret: said once, however many values went there. */
  let unprotected: string | undefined;
  let tracked: string | undefined;

  const held = new Map<string, string>();
  for (const [name, value] of loadEnvValues(file)) if (value.trim() !== "") held.set(name, value.trim());

  /** Keep `entries` in one write: an app's values come together, and none of them may be lost to a later failure. */
  const keep = async (entries: { name: string; value: string }[], replace: boolean): Promise<void> => {
    const names = entries.map((entry) => entry.name);
    const result = await writeValues(agentDir, `${kind} channel`, entries, replace ? names : [], file);
    unprotected ??= result.unprotectedSecretsDir;
    tracked ??= result.trackedFile;
    for (const entry of entries) held.set(entry.name, entry.value);
    written.push(...names);
  };

  /**
   * Whether this run has put an app's values in, or is about to: a value held beside them is an earlier app's (a token
   * kept from one app must never go with the credentials of another), so it is asked for again.
   */
  let renewed = false;

  const accept = async (step: PastedValues, values: Record<string, string>): Promise<void> => {
    const note = await step.check(values);
    renewed = true;
    await keep(
      step.fields.map(({ name }) => ({ name, value: values[name] as string })),
      true,
    );
    say(`${step.fields.map((one) => one.name).join(", ")} saved to ${file}${note ? ` (${note})` : ""}`);
  };

  const pending: PastedValues[] = [];
  /** Ask for the steps gathered so far, together: one page, however many tokens. */
  const ask = async (steps: PastedValues[]): Promise<void> => {
    if (steps.length === 0) return;
    if (person === undefined) await askAtTerminal(steps, held, accept);
    else await askOnPage(kind, steps, held, accept, person);
  };
  const flush = (): Promise<void> => ask(pending.splice(0));

  for (const value of plan.values) {
    if (value.kind === "make") {
      if (held.has(value.name)) kept.push(value.name);
      else await keep([{ name: value.name, value: value.make() }], false);
      continue;
    }
    if (value.kind === "create") {
      if (value.names.every((name) => held.has(name))) {
        kept.push(...value.names);
        continue;
      }
      await flush();
      renewed = true;
      await keep(
        Object.entries(await value.create(person ?? terminalPerson)).map(([name, content]) => ({
          name,
          value: content,
        })),
        true,
      );
      continue;
    }
    const names = value.fields.map((one) => one.name);
    if (!renewed && pending.length === 0 && names.every((name) => held.has(name))) {
      try {
        const note = await value.check(Object.fromEntries(names.map((name) => [name, held.get(name) as string])));
        kept.push(...names);
        say(
          `${names.join(", ")} already set in ${file}${note ? ` (${note})` : ""} — keeping ${names.length > 1 ? "them" : "it"}`,
        );
        continue;
      } catch (error) {
        if (!(error instanceof SetupRefused)) throw error;
        say(`${names.join(", ")} in ${file} is refused (${error.message}) — asking for another`);
      }
    }
    if (value.capture === undefined) {
      pending.push(value);
      continue;
    }
    await flush();
    const captured = await value.capture(held);
    if (captured === undefined) {
      await ask([value]);
      continue;
    }
    await keep([{ name: names[0] as string, value: captured }], true);
    say(`${names[0]} captured and saved to ${file}`);
  }
  await flush();

  if (unprotected !== undefined)
    say(`note: ${unprotectedSecretsNote(unprotected, "where this instance keeps its values")}`);
  if (tracked !== undefined) say(`note: ${trackedValueFileNote(tracked)}`);
  return { written, kept, after: await plan.finish(held) };
}

const guideOf = (step: PastedValues, held: HeldValues): SetupGuide =>
  typeof step.guide === "function" ? step.guide(held) : step.guide;

async function askAtTerminal(
  steps: readonly PastedValues[],
  held: HeldValues,
  accept: (step: PastedValues, values: Record<string, string>) => Promise<void>,
): Promise<void> {
  for (const step of steps) {
    const guide = guideOf(step, held);
    clackLog.info(guide.instructions);
    if (guide.url !== undefined) {
      say(`opening ${guide.url}`);
      openExternalUrl(guide.url);
    }
    for (;;) {
      const values: Record<string, string> = {};
      for (const one of step.fields) {
        for (;;) {
          const message = `${one.label}`;
          const answer = one.secret === false ? await text({ message }) : await password({ message });
          if (isCancel(answer)) throw new Error("setup cancelled");
          const pasted = String(answer).trim();
          if (pasted === "") {
            clackLog.error(`${one.label} is needed.`);
            continue;
          }
          values[one.name] = pasted;
          break;
        }
      }
      try {
        await accept(step, values);
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
  steps: readonly PastedValues[],
  held: HeldValues,
  accept: (step: PastedValues, values: Record<string, string>) => Promise<void>,
  person: Person,
): Promise<void> {
  const product = PRODUCTS[kind];
  const page = await startCredentialsPage({
    title: `Connect ${product}`,
    doneHeading: `${product} connected`,
    steps: steps.map((step) => ({ label: step.label, guide: guideOf(step, held), fields: step.fields })),
    accept: (index, values) => accept(steps[index] as PastedValues, values),
  });
  const port = new URL(page.url).port;
  try {
    person.waitsOn(
      page.url,
      `paste ${steps.map((step) => step.label).join(" and ")} on this page. If the CLI runs remotely, forward this ` +
        `loopback port to the same local port (SSH: ssh -N -L ${port}:127.0.0.1:${port} user@host), then open the ` +
        "same URL in your browser. Keep the forwarding session open; never paste secrets into the conversation.",
    );
    await page.done;
    person.carriesOn();
  } finally {
    await page.close();
  }
}
