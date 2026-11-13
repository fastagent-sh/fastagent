/**
 * Setting up one channel's platform app for one instance: validate existing values in the instance's value file, and
 * either prompt interactively in a terminal or return structured missing steps (stateless, exit 2) for a coding agent.
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
import { openExternalUrl } from "../open-url.ts";
import { startCloudflareTunnel } from "../tunnel.ts";
import { loadEnvValues, trackedValueFileNote, unprotectedSecretsNote, writeValues } from "../value-file.ts";

const SETUPS = {
  telegram: telegramSetup,
  slack: slackSetup,
  feishu: feishuSetup,
  lark: larkSetup,
} as const satisfies Record<string, ChannelSetup>;

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
  /** Interactive terminal mode prompts for missing values; non-interactive mode validates `file` and returns missing steps. */
  interactive: boolean;
}

interface MissingSetupStep {
  label: string;
  fields: { name: string; label: string; secret: boolean }[];
  instructions: string;
  url?: string;
  error?: string;
}

export type SetUpOutcome =
  | {
      status: "done";
      /** The variables this run wrote. */
      written: string[];
      /** The variables that were set already, and are accepted. */
      kept: string[];
      /** What is left to the person once it is done. */
      after: string[];
    }
  | {
      status: "need_user_action";
      file: string;
      steps: MissingSetupStep[];
      interactiveCommand: string;
    };

/** The variables a channel's app needs for `way`, in the order setup asks for them. */
export function setupNames(kind: SetupKind, way: SetupWay): string[] {
  const plan = SETUPS[kind]({ way, appName: "", dev: true, rerun: "", startTunnel: startCloudflareTunnel });
  return plan.values.flatMap((value) =>
    value.kind === "paste" ? value.fields.map((one) => one.name) : value.kind === "create" ? value.names : [value.name],
  );
}

const terminalCreatePerson = {
  waitsOn(url: string, instructions: string): void {
    say(`${instructions}: ${url}`);
    openExternalUrl(url);
  },
  carriesOn(): void {},
};

export async function setUpChannel(input: SetUpChannelInput): Promise<SetUpOutcome> {
  const { kind, agentDir, file, interactive } = input;
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

  const missing: MissingSetupStep[] = [];
  const deferredMakes: { name: string; make(): string }[] = [];

  for (const value of plan.values) {
    if (value.kind === "make") {
      if (held.has(value.name)) kept.push(value.name);
      else if (interactive) await keep([{ name: value.name, value: value.make() }], false);
      else deferredMakes.push(value);
      continue;
    }
    if (value.kind === "create") {
      if (value.names.every((name) => held.has(name))) {
        kept.push(...value.names);
        continue;
      }
      if (!interactive) {
        missing.push({
          label: `${kind} app credentials`,
          fields: value.names.map((name) => ({
            name,
            label: name,
            secret: !name.endsWith("_ID"),
          })),
          instructions:
            `Run \`${input.rerun}\` in a terminal to create the ${kind} app by scan-to-create, or create one in the ` +
            `console and add ${value.names.join(" and ")} to ${file}.`,
          url: kind === "feishu" ? "https://open.feishu.cn/app" : undefined,
        });
        continue;
      }
      renewed = true;
      await keep(
        Object.entries(await value.create(terminalCreatePerson)).map(([name, content]) => ({
          name,
          value: content,
        })),
        true,
      );
      continue;
    }
    const names = value.fields.map((one) => one.name);
    let refusal: string | undefined;
    if (!renewed && missing.length === 0 && names.every((name) => held.has(name))) {
      try {
        const note = await value.check(Object.fromEntries(names.map((name) => [name, held.get(name) as string])));
        kept.push(...names);
        say(
          `${names.join(", ")} already set in ${file}${note ? ` (${note})` : ""} — keeping ${names.length > 1 ? "them" : "it"}`,
        );
        continue;
      } catch (error) {
        if (!(error instanceof SetupRefused)) throw error;
        refusal = `${error.message}${error.fix === undefined ? "" : ` ${error.fix}`}`;
        say(`${names.join(", ")} in ${file} is refused (${error.message})`);
      }
    }
    if (value.capture !== undefined && missing.length === 0) {
      const captured = await value.capture(held);
      if (captured !== undefined) {
        await keep([{ name: names[0] as string, value: captured }], true);
        say(`${names[0]} captured and saved to ${file}`);
        continue;
      }
    }
    if (!interactive) {
      const guide = guideOf(value, held);
      missing.push({
        label: value.label,
        fields: value.fields.map((f) => ({ name: f.name, label: f.label, secret: f.secret !== false })),
        instructions: guide.instructions,
        ...(guide.url === undefined ? {} : { url: guide.url }),
        ...(refusal === undefined ? {} : { error: refusal }),
      });
      continue;
    }
    await askAtTerminal([value], held, accept);
  }

  if (missing.length > 0) {
    return {
      status: "need_user_action",
      file,
      steps: missing,
      interactiveCommand: input.rerun,
    };
  }
  for (const one of deferredMakes) {
    await keep([{ name: one.name, value: one.make() }], false);
  }

  if (unprotected !== undefined)
    say(`note: ${unprotectedSecretsNote(unprotected, "where this instance keeps its values")}`);
  if (tracked !== undefined) say(`note: ${trackedValueFileNote(tracked)}`);
  return { status: "done", written, kept, after: await plan.finish(held) };
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
