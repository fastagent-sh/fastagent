/**
 * `fastagent channels setup <name>`: set up one channel's platform app for one instance (channel-setup.md §2): ask a
 * person for the values only they have, check them with the platform, and keep them in the instance's value file.
 * With `--record-url`: record, in the configuration a deploy delivers, the URL a person set on a Slack or Lark app's
 * page, once the deployment confirms the platform reaches it there (§5).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordChannelUrl } from "../channel-app.ts";
import { type SetupKind, isSetupKind, setUpChannel } from "../channel-setup.ts";
import type { SetupWay } from "../../channels/setup.ts";
import { type WebhookKind, webhookPath } from "../../channels/webhooks.ts";
import { enterAgentEnv } from "../../env.ts";
import { readInstanceConfigFile, resolveConfig } from "../../harnesses/pi-durable/config.ts";
import { chosenIngress } from "../../harnesses/pi-durable/definition.ts";
import { buildDefinitionShape, loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { setChannelConfig } from "../../authoring.ts";
import { INSTANCE_CONFIG_FILE, resolveOverridePath, selectAgentEnvironment } from "../../paths.ts";
import { markDevServe, unmarkDevServe } from "../../serving-command.ts";
import { dotEnvPath, loadEnvValues, useValueFile } from "../../value-file.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import type { Person } from "../person.ts";
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

export interface ChannelsSetupOptions {
  recordUrl: boolean;
  /** The instance configuration: what names how the channel receives, and where `--ingress` is written. */
  config?: string;
  /** The value file the credentials are kept in (created when missing). */
  envFile?: string;
  ingress?: string;
  url?: string;
  json: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--check <ticket>`: where a setup started without a terminal stands. */
  check?: string;
  /** `--timeout <seconds>`: how long a setup started without a terminal stays open. */
  timeout?: string;
  /** `--ticket <id>`: the process that runs a ticket's setup. */
  ticket?: string;
}

/** Without a terminal, how long a setup stays open for the person to finish their part. */
const UNATTENDED_TIMEOUT_SECONDS = 900;

export async function runChannelsSetup(name: string, dirArg: string, opts: ChannelsSetupOptions): Promise<void> {
  if (opts.check !== undefined) return checkSetup(name, opts.check, opts);
  if (opts.recordUrl) return recordUrl(name, dirArg, opts);
  if (!isSetupKind(name)) {
    failUsage(
      `${name}: this release sets up telegram and slack (\`fastagent add ${name}\` sets up that app itself for now)`,
    );
  }
  if (opts.ticket !== undefined) {
    // The process `startTicket` started: it takes the ticket before anything slow (the definition is loaded to plan),
    // then does the whole setup, its person the ticket's.
    await runTicket(opts.ticket, async (step) => ({
      ...(await carryOut(await planSetup(name, dirArg, opts), step.person)),
    }));
    process.exit(0);
  }
  const plan = await planSetup(name, dirArg, opts);
  if (opts.input === false || opts.json || !isInteractive()) return setUpUnattended(plan, opts);
  const outcome = await carryOut(plan).catch(failStartup);
  console.error("  next steps:");
  for (const line of outcome.next_steps) console.error(`    ${line}`);
  // Platform sockets left open would hold a one-shot command open after everything durable is done.
  process.exit(0);
}

/** What a setup settles before it asks anything, refusing what it can while nothing has changed. */
interface SetupPlan {
  kind: SetupKind;
  agentDir: string;
  /** Whether this is the development instance: no configuration and no value file named. */
  dev: boolean;
  file: string;
  way: SetupWay;
  publicUrl: string | undefined;
  /** The configuration `--ingress` is written to, when it was given. */
  writeIngress: string | undefined;
  /** The command that runs it again. */
  rerun: string;
}

async function planSetup(kind: SetupKind, dirArg: string, opts: ChannelsSetupOptions): Promise<SetupPlan> {
  if (opts.ingress !== undefined && opts.ingress !== "webhook" && opts.ingress !== "connection") {
    failUsage(`--ingress must be "webhook" or "connection", got "${opts.ingress}"`);
  }
  const agentDir = agentDirOrExit(resolve(dirArg));
  // The development instance is the default one; naming a configuration or a value file is naming another.
  const dev = opts.config === undefined && opts.envFile === undefined;
  selectAgentEnvironment(dev ? "dev" : "production");
  if (dev) markDevServe();
  else unmarkDevServe();
  if (opts.envFile !== undefined) {
    if (opts.envFile.trim() === "") failUsage("--env-file needs a path");
    useValueFile(resolveOverridePath(opts.envFile));
  }
  enterAgentEnv(agentDir);
  const file = dotEnvPath(agentDir);
  const config =
    opts.config !== undefined ? resolve(opts.config) : dev ? join(agentDir, INSTANCE_CONFIG_FILE) : undefined;
  if (opts.ingress !== undefined && config === undefined) {
    failUsage("--ingress writes into a configuration: pass --config <file>, the one `deploy --config` delivers");
  }
  const definition = await loadSourceDefinition(agentDir).catch(failStartup);
  const instance =
    config !== undefined && existsSync(config) ? await readInstanceConfigFile(config).catch(failStartup) : undefined;
  const effective = resolveConfig(definition, instance);
  const way = (opts.ingress as SetupWay | undefined) ?? chosenIngress(effective, kind, dev);
  // A channel file that names its factory receives one way whatever the configuration says: setting the app up for
  // the other would change nothing but the app.
  if (existsSync(join(agentDir, "src", "channels", `${kind}.ts`))) {
    try {
      buildDefinitionShape(definition, process.env, {
        settings: definition.config.defaults?.settings ?? {},
        channels: { [kind]: { ingress: way } },
      });
    } catch (error) {
      failStartup(new Error(`the agent does not build for ${kind} to receive by ${way} (${(error as Error).message})`));
    }
  }
  const publicUrl = effective.http?.publicUrl;
  return {
    kind,
    agentDir,
    dev,
    file,
    way,
    publicUrl,
    writeIngress: opts.ingress === undefined ? undefined : config,
    rerun:
      `fastagent channels setup ${kind} ${shellArg(agentDir)}` +
      `${opts.ingress === undefined ? "" : ` --ingress ${opts.ingress}`}` +
      `${opts.config === undefined ? "" : ` --config ${shellArg(resolve(opts.config))}`}` +
      `${opts.envFile === undefined ? "" : ` --env-file ${shellArg(resolve(opts.envFile))}`}`,
  };
}

/** The setup itself, once its person's part can be done: the values, the way written down, and what comes next. */
async function carryOut(
  plan: SetupPlan,
  person?: Person,
): Promise<{ written: string[]; kept: string[]; next_steps: string[] }> {
  const outcome = await setUpChannel({
    kind: plan.kind,
    agentDir: plan.agentDir,
    file: plan.file,
    way: plan.way,
    ...(plan.publicUrl === undefined ? {} : { publicUrl: plan.publicUrl }),
    ...(person === undefined ? {} : { person }),
  });
  if (plan.writeIngress !== undefined) {
    await setChannelConfig(plan.agentDir, plan.kind, { ingress: plan.way }, { config: plan.writeIngress });
    console.error(`[fastagent] wrote channels.${plan.kind}.ingress "${plan.way}" to ${plan.writeIngress}`);
  }
  const serve = plan.dev
    ? "fastagent dev"
    : `fastagent start --env-file ${shellArg(plan.file)}   # or, from .secrets/production/.env, fastagent deploy <host> --run`;
  return { written: outcome.written, kept: outcome.kept, next_steps: [serve, ...outcome.after] };
}

/** The command that reads a setup's ticket, as every such ticket records it. */
const setupCheck = (kind: string) => `fastagent channels setup ${kind} --check`;

/**
 * A setup with no one at a terminal to ask, for a coding agent: it runs in a process of its own (ticket.ts), and the
 * command returns once the person has a step to take, it is done, or it is still working at it. What only the person
 * has is pasted on a page of the setup's own, never asked for in the agent's conversation and never typed into a file.
 */
async function setUpUnattended(plan: SetupPlan, opts: ChannelsSetupOptions): Promise<void> {
  const timeout = opts.timeout === undefined ? UNATTENDED_TIMEOUT_SECONDS : Number(opts.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) failUsage("--timeout must be a whole number of seconds");
  const ticket = await startTicket({
    // One setup per agent, channel and value file: another one's is its own business.
    subject: `channels-setup:${plan.kind}:${plan.file}`,
    action: `set up the ${plan.kind} app: paste its credentials on a page`,
    check: setupCheck(plan.kind),
    restart: plan.rerun,
    timeoutSeconds: timeout,
    waitsFirst: false,
    whenRunning: "replace",
    command: {
      file: process.execPath,
      args: [
        ...process.execArgv,
        process.argv[1] as string,
        "channels",
        "setup",
        plan.kind,
        plan.agentDir,
        ...(opts.ingress === undefined ? [] : ["--ingress", opts.ingress]),
        ...(opts.config === undefined ? [] : ["--config", resolve(opts.config)]),
        ...(opts.envFile === undefined ? [] : ["--env-file", resolve(opts.envFile)]),
      ],
      cwd: process.cwd(),
    },
  });
  reportSetup(ticket, opts, "started");
  process.exit(ticketExitCode(ticket));
}

/** `channels setup <name> --check <ticket>`. */
async function checkSetup(name: string, id: string, opts: ChannelsSetupOptions): Promise<void> {
  const refused = refusedCheck(id, setupCheck(name));
  if (refused !== undefined) failUsage(refused);
  // There: refusedCheck read it, and a ticket is pruned only a day after it ends.
  const ticket = (await checkTicket(id)) as Ticket;
  reportSetup(ticket, opts, "checked");
  process.exit(ticketExitCode(ticket));
}

/** A setup's ticket for whoever started or checked it: the shared report, and what a finished setup adds. */
function reportSetup(ticket: Ticket, opts: ChannelsSetupOptions, when: "started" | "checked"): void {
  const { json, text } = ticketReport(ticket, when, (result) => {
    const written = (result.written as string[] | undefined) ?? [];
    const kept = (result.kept as string[] | undefined) ?? [];
    const next = (result.next_steps as string[] | undefined) ?? [];
    return {
      fields: { written, kept, next_steps: next },
      text: [...(written.length > 0 ? [`wrote ${written.join(", ")}`] : []), ...next.map((line) => `next: ${line}`)],
      next: "The app is set up. Its next steps are in next_steps.",
    };
  });
  printReport(opts.json, json, text);
}

async function recordUrl(name: string, dirArg: string, opts: ChannelsSetupOptions): Promise<void> {
  if (name !== "slack" && name !== "lark") {
    failUsage(`${name}: only slack and lark have a URL a person sets (the instance points the others itself)`);
  }
  if (opts.config === undefined)
    failUsage("--record-url writes into the configuration a deploy delivers: pass --config <file>");
  const agentDir = agentDirOrExit(resolve(dirArg));
  selectAgentEnvironment("production");
  if (opts.envFile !== undefined) useValueFile(resolveOverridePath(opts.envFile));
  // The deployment's /health and the platform are reached as the instance's values and environment say, a proxy included.
  enterAgentEnv(agentDir);
  const config = resolve(opts.config);
  const source = await readInstanceConfigFile(config).catch(failStartup);
  const named = (source.values as { http?: { publicUrl?: unknown } }).http?.publicUrl;
  const configured = typeof named === "string" ? named.replace(/\/+$/, "") : undefined;
  // `--url` is where this machine reads the deployment's /health; the URL the box confirms is the configuration's
  // own http.publicUrl when it names one, the one the platforms reach.
  const reach = opts.url?.replace(/\/+$/, "") ?? configured;
  const base = configured ?? reach;
  if (reach === undefined || base === undefined) {
    failUsage(`${config} names no http.publicUrl: pass --url <the deployment's public URL>`);
  }
  const kind = name as WebhookKind;
  const url = `${base}${webhookPath(kind)}`;
  const outcome = await healthOutcome(`${reach}/health`, kind).catch(failStartup);
  if (outcome !== "registered") {
    failStartup(
      new Error(
        `${kind}: the deployment at ${reach} reports it ${outcome ?? "not listed"}, not reached at ${url} yet — save ` +
          `${url} on the app's page (the platform verifies it with the deployment), then run this again`,
      ),
    );
  }
  await recordChannelUrl(agentDir, config, kind, url, loadEnvValues(dotEnvPath(agentDir))).catch(failStartup);
  printReport(opts.json, { status: "done", channel: kind, url, config }, [`recorded ${url} for ${kind} in ${config}`]);
}

/** The outcome the deployment's `/health` reports for `kind`, or undefined when it lists none. */
async function healthOutcome(healthUrl: string, kind: WebhookKind): Promise<string | undefined> {
  let body: { webhooks?: { channel: string; outcome: string }[] };
  try {
    body = (await (await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })).json()) as typeof body;
  } catch (error) {
    throw new Error(`could not read ${healthUrl}: ${String(error)}`, { cause: error });
  }
  return body.webhooks?.find((entry) => entry.channel === kind)?.outcome;
}
