/**
 * `fastagent add <channel>|skill` — scaffold channel glue (`src/channels/<kind>.ts`) or vendor an Agent Skills skill.
 * slack/feishu/lark additionally CREATE OR RESUME the platform app.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertIndependentFeishuApps, onboardFeishuCloudApp } from "../add-feishu.ts";
import { type Person, terminalPerson } from "../person.ts";
import { isInteractive, shellArg } from "../shared.ts";
import {
  type Ticket,
  checkTicket,
  printReport,
  refusedCheck,
  runTicket,
  startTicket,
  ticketExitCode,
  ticketReport,
} from "../ticket.ts";
import type { FeishuSubscriptionMode } from "../../channels/feishu/setup-mode.ts";
import { markDevServe, unmarkDevServe } from "../../serving-command.ts";
import { buildDefinitionShape, loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { readInstanceConfigFile, resolveConfig } from "../../harnesses/pi-durable/config.ts";
import { setChannelConfig } from "../../authoring.ts";
import { enterAgentEnv } from "../../env.ts";
import { dotEnvPath, loadEnvValues } from "../../value-file.ts";
import {
  INSTANCE_CONFIG_FILE,
  selectAgentEnvironment,
  resolveStateRoot,
  SECRETS_DIRNAME,
  isUnderDir,
  displayPath,
} from "../../paths.ts";
import { detectRuntime, readPackageJson } from "../../runtime.ts";
import {
  type ChannelKind,
  appendChannelDotEnv,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
  scaffoldCompanionTools,
} from "../../scaffold/add-channel.ts";
import { vendorSkill } from "../../scaffold/vendor-skill.ts";
import { failStartup, failUsage, agentDirOrExit } from "../fail.ts";
import { unprotectedSecretsNote } from "../../value-file.ts";

export interface AddChannelOptions {
  ingress?: string;
  /** `--config <file>`: the instance configuration `--ingress` writes and the setup reads. */
  config?: string;
  onboard?: boolean;
  replaceConfig?: boolean;
  environment?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--json`: the outcome as one JSON object on stdout. */
  json?: boolean;
  /** `--check <ticket>`: where an app's setup started without a terminal stands. */
  check?: string;
  /** `--timeout <seconds>`: how long a setup started without a terminal stays open. */
  timeout?: string;
  /** `--ticket <id>`: the process that runs a ticket's setup. */
  ticket?: string;
}

/** Without a terminal, how long an app's setup stays open for the person to finish their part. */
const UNATTENDED_TIMEOUT_SECONDS = 900;

/** `fastagent add <kind> [dir]`: scaffold `src/channels/<kind>.ts`, the adapter configured with a starter policy. */
export async function runAddChannel(channelKind: ChannelKind, dirArg: string, opts: AddChannelOptions): Promise<void> {
  if (opts.check !== undefined) return checkSetup(channelKind, opts.check, opts);
  if (opts.ticket !== undefined) {
    // The process `startTicket` started: it takes the ticket before anything slow (the definition is built to plan),
    // then does the whole `add`, its person the ticket's.
    await runTicket(opts.ticket, async (step) => ({
      ...(await addChannel(channelKind, await planAdd(channelKind, dirArg, opts), opts, step.person)),
    }));
    process.exit(0);
  }
  const plan = await planAdd(channelKind, dirArg, opts);
  const unattended = opts.input === false || opts.json === true || !isInteractive();
  if (unattended && opts.onboard !== false && channelKind !== "telegram") {
    return setUpUnattended(channelKind, opts, plan);
  }
  const added = await addChannel(channelKind, plan, opts, terminalPerson).catch(failStartup);
  if (opts.json) console.log(JSON.stringify({ status: "done", ...added }, null, 2));
  // App-creation flows leave platform/tunnel sockets behind that would otherwise hold the one-shot scaffold command
  // open after all durable boundaries have completed.
  process.exit(0);
}

/** What `add` settles before it changes anything, refusing what it can while nothing has changed. */
async function planAdd(channelKind: ChannelKind, dirArg: string, opts: AddChannelOptions): Promise<AddPlan> {
  // The channel (glue + companion tools + secrets) is agent surface: everything lands in the AGENT DIR.
  if (opts.replaceConfig && opts.onboard === false) {
    failUsage("--replace-config replaces onboarding credentials; it cannot be combined with --no-onboard");
  }
  const target = agentDirOrExit(resolve(dirArg));
  const environment = opts.environment ?? "dev";
  if (environment !== "dev" && environment !== "production") {
    failUsage(`--env must be "dev" or "production", got "${environment}"`);
  }
  selectAgentEnvironment(environment);
  if (environment === "production") unmarkDevServe();
  else markDevServe();
  enterAgentEnv(target);
  if (environment === "production" && (channelKind === "feishu" || channelKind === "lark")) {
    try {
      assertIndependentFeishuApps(target, [channelKind], loadEnvValues(dotEnvPath(target)));
    } catch (error) {
      failStartup(error);
    }
  }
  // Paths are printed to someone standing in their CWD, which may be elsewhere, while every file belongs to the AGENT
  // dir — prefix them, or they point at nothing.
  const agentFromCwd = displayPath(process.cwd(), target);
  const inAgent = (p: string): string => (agentFromCwd === undefined ? p : join(agentFromCwd, p));
  // An existing channel file is authored glue: kept, never rewritten.
  const file = join(target, "src", "channels", `${channelKind}.ts`);
  const existsAlready = await channelExists(target, channelKind).catch(failStartup);
  const config = instanceConfigPath(target, environment, opts);
  const ingress = await resolveIngress(target, channelKind, environment, opts.ingress, config);
  if (
    existsAlready &&
    (ingress.write || (environment === "production" && opts.onboard !== false)) &&
    (channelKind === "feishu" || channelKind === "lark")
  ) {
    await assertChannelReceives(target, channelKind, ingress.ingress);
  }
  return {
    target,
    environment,
    inAgent,
    agentFromCwd,
    file,
    existsAlready,
    ...ingress,
    rerun:
      `fastagent add ${channelKind}${agentFromCwd === undefined ? "" : ` ${shellArg(agentFromCwd)}`}` +
      `${environment === "production" ? " --env production" : ""}${opts.ingress ? ` --ingress ${opts.ingress}` : ""}` +
      `${opts.config === undefined ? "" : ` --config ${shellArg(resolve(opts.config))}`}` +
      `${opts.replaceConfig ? " --replace-config" : ""}`,
  };
}

/** What `add` settled before it does anything: where, for which environment, and how the app receives. */
interface AddPlan {
  target: string;
  environment: string;
  inAgent: (path: string) => string;
  agentFromCwd: string | undefined;
  file: string;
  existsAlready: boolean;
  ingress: FeishuSubscriptionMode;
  /** The instance configuration `--ingress` is written to, when it is. */
  write?: string;
  /** The command that continues an interrupted setup. */
  rerun: string;
}

/**
 * Everything `add <kind>` does once the person's part can be done: the channel, its tools and variables, the app's
 * onboarding through `person`, and the next steps, printed and returned with the variables it wrote.
 */
async function addChannel(
  channelKind: ChannelKind,
  plan: AddPlan,
  opts: AddChannelOptions,
  person: Person,
): Promise<{ written: string[]; next_steps: string[] }> {
  const { target, environment, inAgent, agentFromCwd, file, existsAlready, ingress, write, rerun } = plan;
  const envPath = dotEnvPath(target);
  const envLabel = isUnderDir(envPath, target) ? inAgent(relative(target, envPath)) : envPath;
  const before = loadEnvValues(envPath);
  if (existsAlready) {
    console.error(`[fastagent] ${inAgent(relative(target, file))} already exists — keeping it`);
  } else {
    await assertChannelReady(target);
    await scaffoldChannel(target, channelKind);
    console.error(`[fastagent] created ${inAgent(relative(target, file))}`);
  }
  // Companion tools are the package's, not authored glue.
  for (const tool of await scaffoldCompanionTools(target, channelKind)) {
    console.error(`[fastagent] wrote ${inAgent(relative(target, tool))}`);
  }
  if (await appendChannelEnv(target, channelKind)) {
    console.error(`[fastagent] added ${channelKind} env vars to ${inAgent(join(SECRETS_DIRNAME, ".env.example"))}`);
  }
  // Stateful app onboarding is re-runnable after the scaffold boundary.
  let created: Record<string, string> | undefined;
  if (channelKind === "slack" && opts.onboard !== false) {
    const { onboardSlackInternalApp } = await import("../add-slack.ts");
    created = await onboardSlackInternalApp({
      target,
      stateRoot: resolveStateRoot(target),
      replaceConfig: opts.replaceConfig,
      ...(person === terminalPerson ? {} : { person }),
    }).then(() => undefined);
  } else if ((channelKind === "feishu" || channelKind === "lark") && opts.onboard !== false) {
    created = await onboardFeishuCloudApp(target, channelKind, ingress, rerun, person);
  }
  if (write !== undefined) {
    await setChannelConfig(target, channelKind, { ingress }, { config: write });
    console.error(
      `[fastagent] wrote channels.${channelKind}.ingress "${ingress}" to ` +
        `${isUnderDir(write, target) ? inAgent(relative(target, write)) : write}`,
    );
  }
  const setup = channelSetup(channelKind, ingress);
  const env = setup.env;
  const steps =
    channelKind === "slack" && opts.onboard !== false
      ? [
          // No line about the Request URL: the `dev --tunnel` line below is the whole instruction, and FastAgent sets
          // that URL itself when the agent first runs.
          "invite the app to each channel it should read",
          // The tool lines are the scaffold's (one list), whichever path set the app up.
          ...setup.steps.filter((step) => step.includes("{tools}/")),
        ]
      : setup.steps;
  const generated = Object.fromEntries(
    env.filter((e) => e.generate).map((e) => [e.name, randomBytes(24).toString("hex")]),
  );
  // Kind-neutral: every channel's generated secrets get the same treatment.
  const dotEnv = await appendChannelDotEnv(
    target,
    channelKind,
    { ...generated, ...created },
    Object.keys(created ?? {}),
    ingress,
  );
  if (dotEnv.unprotectedSecretsDir) {
    console.error(`[fastagent] note: ${unprotectedSecretsNote(dotEnv.unprotectedSecretsDir)}`);
  }
  if (dotEnv.written.length > 0) {
    console.error(`[fastagent] wrote ${dotEnv.written.join(", ")} to ${envLabel}`);
  }
  const install =
    detectRuntime(target, await readPackageJson(target)).runtime === "bun" ? "bun install" : "npm install";
  const next: string[] = [];
  /** One next step: printed, and returned for a caller that reads them as data. */
  const step = (line: string): void => {
    next.push(line.trim());
    console.error(`    ${line}`);
  };
  console.error(`  next steps:`);
  step(
    `${agentFromCwd === undefined ? install : `(cd ${agentFromCwd} && ${install})`}                      # if @fastagent-sh/fastagent is not installed yet`,
  );
  // Onboarding writes some itself (an app's ID and secret, a bot token) before the write above: what this `add` wrote is
  // what the file holds now and did not before.
  const now = loadEnvValues(envPath);
  const written = [...now.keys()].filter((name) => now.get(name) && now.get(name) !== before.get(name));
  for (const e of env) {
    if (!written.includes(e.name) && dotEnv.alreadySet.includes(e.name)) continue; // the user's already: nothing to do
    if (written.includes(e.name)) {
      // Written, but its hint may still carry an action — keep the variable visible instead of silently absorbing it.
      step(`${e.name} — ${e.generate ? "generated and " : ""}written to ${envLabel}   # ${e.hint}`);
      continue;
    }
    const value = e.generate ? `=${generated[e.name]}` : "";
    const action = e.required ? "set" : "optionally set";
    step(`${action} ${e.name}${value} in ${envLabel}   # ${e.hint}`);
  }
  const serveCommand = environment === "production" ? "fastagent build && fastagent start" : "fastagent dev";
  for (const s of steps) {
    step(
      s
        .replace("{channel}", inAgent(relative(target, file)))
        .replace("{tools}", inAgent(join("src", "tools")))
        .replaceAll("{serve}", serveCommand),
    );
  }
  if (environment === "production") {
    step(`fastagent deploy <host> --run   # deploy with the production app and credentials`);
  } else if (ingress === "connection") {
    step(`fastagent dev            # no public URL or tunnel required`);
  } else if (channelKind === "slack") {
    step(
      `fastagent dev --tunnel   # ${opts.onboard === false ? "serve locally + print the URL to paste into the Slack app's Event Subscriptions" : "start the agent — then message it in Slack"}`,
    );
  } else if (channelKind !== "lark") {
    step(`fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
  }
  return { written, next_steps: next };
}

/** The command that reads an app's setup ticket, as every such ticket records it. */
const setupCheck = (kind: ChannelKind) => `fastagent add ${kind} --check`;

/** What the person does for each kind's app, to follow "so they can". */
const SETUP_ACTIONS: Record<"slack" | "feishu" | "lark", string> = {
  slack: "set up the Slack app: paste a configuration token on the page, then click Allow in Slack",
  feishu: "confirm the new Feishu app",
  lark: "finish setting up the Lark app",
};

/**
 * `add slack|feishu|lark` with no one at a terminal to ask, for a coding agent: the app's setup runs in a process of its
 * own (ticket.ts), and the command returns once the person has a step to take, it is done, or it is still working at it.
 * What only the person has (Slack's tokens, Lark's App ID and Secret) is pasted on a page of the setup's own, never asked
 * for in the agent's conversation and never typed into a file.
 */
async function setUpUnattended(kind: "slack" | "feishu" | "lark", opts: AddChannelOptions, at: AddPlan): Promise<void> {
  const { target } = at;
  const timeout = opts.timeout === undefined ? UNATTENDED_TIMEOUT_SECONDS : Number(opts.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) failUsage(`--timeout must be a whole number of seconds`);
  const ticket = await startTicket({
    // One setup per agent, channel and environment: another agent's is its own business.
    subject: `add:${kind}:${at.environment}:${target}`,
    action: SETUP_ACTIONS[kind],
    check: setupCheck(kind),
    restart: at.rerun,
    timeoutSeconds: timeout,
    waitsFirst: false,
    whenRunning: "replace",
    command: {
      file: process.execPath,
      args: [
        ...process.execArgv,
        process.argv[1] as string,
        "add",
        kind,
        target,
        ...(at.environment === "production" ? ["--env", "production"] : []),
        ...(opts.ingress === undefined ? [] : ["--ingress", opts.ingress]),
        ...(opts.config === undefined ? [] : ["--config", resolve(opts.config)]),
        ...(opts.replaceConfig ? ["--replace-config"] : []),
      ],
      cwd: process.cwd(),
    },
  });
  reportSetup(ticket, opts, "started");
  process.exit(ticketExitCode(ticket));
}

/** `add <kind> --check <ticket>`. */
async function checkSetup(kind: ChannelKind, id: string, opts: AddChannelOptions): Promise<void> {
  const refused = refusedCheck(id, setupCheck(kind));
  if (refused !== undefined) failUsage(refused);
  // There: refusedCheck read it, and a ticket is pruned only a day after it ends.
  const ticket = (await checkTicket(id)) as Ticket;
  reportSetup(ticket, opts, "checked");
  process.exit(ticketExitCode(ticket));
}

/** An app's setup ticket for whoever started or checked it: the shared report, and what a finished setup adds. */
function reportSetup(ticket: Ticket, opts: AddChannelOptions, when: "started" | "checked"): void {
  const { json, text } = ticketReport(ticket, when, (result) => {
    const written = (result.written as string[] | undefined) ?? [];
    const next = (result.next_steps as string[] | undefined) ?? [];
    return {
      fields: { written, next_steps: next },
      text: [...(written.length > 0 ? [`wrote ${written.join(", ")}`] : []), ...next.map((line) => `next: ${line}`)],
      next: `The app is set up. Its next steps are in next_steps.`,
    };
  });
  printReport(opts.json, json, text);
}

/**
 * The instance configuration `add` reads how the channel receives from, and writes `--ingress` to: `--config`, else
 * the development instance's `fastagent.json`. A deployment's is the one `deploy --config` delivers, so production
 * has none unless one is named.
 */
function instanceConfigPath(target: string, environment: string, opts: AddChannelOptions): string | undefined {
  if (opts.config !== undefined) return resolve(opts.config);
  if (environment === "dev") return join(target, INSTANCE_CONFIG_FILE);
  if (opts.ingress !== undefined) {
    failUsage(
      "--ingress with --env production is a deployment's configuration: pass --config <file>, the one " +
        "`deploy --config` delivers",
    );
  }
  return undefined;
}

/**
 * What `add` sets the app up for, and where it writes the choice down: `--ingress`, written to the instance
 * configuration; else what that configuration says; else the rule every serve follows, WebSocket in dev and webhook
 * everywhere else.
 */
async function resolveIngress(
  target: string,
  kind: ChannelKind,
  environment: string,
  raw: string | undefined,
  config: string | undefined,
): Promise<{ ingress: FeishuSubscriptionMode; write?: string }> {
  if (raw !== undefined && raw !== "webhook" && raw !== "connection") {
    failUsage(`--ingress must be "webhook" or "connection", got "${raw}"`);
  }
  if (kind !== "feishu" && kind !== "lark") return { ingress: "webhook" };
  if (raw !== undefined) return { ingress: raw, ...(config === undefined ? {} : { write: config }) };
  const named =
    config === undefined || !existsSync(config)
      ? undefined
      : await Promise.all([loadSourceDefinition(target), readInstanceConfigFile(config)])
          .then(([definition, source]) => resolveConfig(definition, source).channels?.[kind]?.ingress)
          .catch(failStartup);
  return { ingress: named ?? (environment === "dev" ? "connection" : "webhook") };
}

/**
 * A channel file that names its factory receives one way whatever the configuration says, so setting up the app for
 * the other way would change nothing but the app. Asked of the channel as the agent builds it, the way `add` is about
 * to set it up for.
 */
async function assertChannelReceives(
  target: string,
  kind: ChannelKind,
  ingress: FeishuSubscriptionMode,
): Promise<void> {
  await loadSourceDefinition(target)
    .then((definition) =>
      buildDefinitionShape(definition, process.env, {
        settings: definition.config.defaults?.settings ?? {},
        channels: { [kind]: { ingress } },
      }),
    )
    .catch((error: unknown) =>
      failStartup(new Error(`the agent does not build (${(error as Error).message}) — fix it and re-run`)),
    );
}

/** `fastagent add skill <source> [dir]`: vendor an Agent Skills skill into <dir>/skills/<name>/. */
export async function runAddSkill(
  source: string | undefined,
  dirArg: string,
  opts: { update?: boolean },
): Promise<void> {
  const target = agentDirOrExit(resolve(dirArg));
  if (!source) {
    // A missing source is a usage error (exit 2), but the guide is worth more than a bare missing-argument line.
    failUsage(
      `add a skill — two ways:\n` +
        `  1. write your own (vibe): create skills/<name>/SKILL.md with name + description\n` +
        `     frontmatter; it's auto-discovered. No command needed — this is the common path.\n` +
        `  2. vendor an existing Agent Skills skill (copied in, git-tracked):\n` +
        `       fastagent add skill <source> [dir]\n` +
        `     source: a git ref (owner/repo/path, github default), a local path (./x, /abs), or a\n` +
        `             bare name found in your global skill dirs (~/.agents/skills, ~/.pi/agent/skills)\n` +
        `     --update overwrites an existing skill (re-fetch from source); review with git diff`,
    );
  }
  // Skills are agent surface — vendored into the agent dir's `skills/`.
  enterAgentEnv(target); // a git-ref source is a network fetch (giget uses global fetch)
  const { name, description, dest, hasScripts, overwritten } = await vendorSkill(target, source, {
    update: opts.update ?? false,
  }).catch(failStartup);
  console.error(`[fastagent] ${overwritten ? "updated" : "vendored"} skill "${name}" → ${dest}/`);
  if (overwritten) console.error(`  overwrote it — \`git diff ${dest}\` to review, \`git checkout ${dest}\` to revert`);
  if (description) console.error(`  ${description.length > 100 ? `${description.slice(0, 100)}…` : description}`);
  if (hasScripts) {
    console.error(
      `  warn: this skill ships scripts/ (executable code that runs in your agent) — review it before deploying`,
    );
  }
  console.error(`  next: mention "${name}" in SYSTEM.md so the model knows when to use it; then \`fastagent dev\``);
}
