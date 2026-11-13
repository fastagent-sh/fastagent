/**
 * `fastagent channels setup <name>`: set up one channel's platform app for one instance: ask a
 * person for the values only they have, check them with the platform, and keep them in the instance's value file.
 * With `--record-url`: record, in the configuration a deploy delivers, the URL a person set on a Slack or Lark app's
 * page, once the deployment confirms the platform reaches it there.
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
import { INSTANCE_CONFIG_FILE, selectAgentEnvironment } from "../../paths.ts";
import { markDevServe, unmarkDevServe } from "../../serving-command.ts";
import { dotEnvPath, loadEnvValues, namedValueFile } from "../../value-file.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { enterEnvFile } from "../instance.ts";
import { shellArg } from "../../shell-arg.ts";
import { isInteractive, printReport } from "../shared.ts";
import { stripTrailingSlashes } from "../../strip-edges.ts";

export interface ChannelsSetupOptions {
  recordUrl: boolean;
  /** The instance configuration: what names how the channel receives, and where `--ingress` is written. */
  config?: string;
  /** The value file the credentials are kept in (created when missing). */
  envFile?: string;
  /** `--record-url`: the environment is a source of the app's credentials too, beside `--env-file`. */
  fromEnv?: boolean;
  ingress?: string;
  url?: string;
  json: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

export async function runChannelsSetup(name: string, dirArg: string, opts: ChannelsSetupOptions): Promise<void> {
  if (opts.recordUrl) return recordUrl(name, dirArg, opts);
  if (!isSetupKind(name)) {
    failUsage(`${name}: \`channels setup\` sets up telegram, slack, feishu and lark`);
  }
  const plan = await planSetup(name, dirArg, opts);
  const interactive = opts.input !== false && !opts.json && isInteractive();
  const outcome = await setUpChannel({
    kind: plan.kind,
    agentDir: plan.agentDir,
    file: plan.file,
    way: plan.way,
    dev: plan.dev,
    rerun: plan.rerun,
    interactive,
    ...(plan.publicUrl === undefined ? {} : { publicUrl: plan.publicUrl }),
  }).catch(failStartup);

  if (outcome.status === "need_user_action") {
    const names = outcome.steps.flatMap((step) => step.fields.map((field) => field.name));
    const json = {
      status: "need_user_action",
      channel: plan.kind,
      file: outcome.file,
      steps: outcome.steps,
      rerun: `${plan.rerun} --json`,
      terminal_command: plan.rerun,
      agent_next_steps:
        `Do not ask the user to paste secrets into the conversation. Ask them to add ${names.join(", ")} to ` +
        `${outcome.file} (or run \`${plan.rerun}\` in their terminal), then re-run \`${plan.rerun} --json\`.`,
    };
    const text = [
      `need_user_action: ${plan.kind} credentials missing or invalid in ${outcome.file}`,
      ...outcome.steps.flatMap((step) => [
        `  ${step.label}: ${step.instructions}`,
        ...(step.url === undefined ? [] : [`    url: ${step.url}`]),
        ...(step.error === undefined ? [] : [`    error: ${step.error}`]),
        `    fields: ${step.fields.map((f) => f.name).join(", ")}`,
      ]),
      `  in a terminal: ${plan.rerun}`,
    ];
    printReport(opts.json, json, text);
    process.exit(2);
  }

  if (plan.writeIngress !== undefined) {
    await setChannelConfig(plan.agentDir, plan.kind, { ingress: plan.way }, { config: plan.writeIngress });
    console.error(`[fastagent] wrote channels.${plan.kind}.ingress "${plan.way}" to ${plan.writeIngress}`);
  }
  const serve = plan.dev
    ? "fastagent dev"
    : `fastagent start --env-file ${shellArg(plan.file)}   # or: fastagent deploy <host> --run --env-file ${shellArg(plan.file)}`;
  const nextSteps = [serve, ...outcome.after];
  if (opts.json) {
    printReport(
      true,
      {
        status: "done",
        channel: plan.kind,
        file: plan.file,
        written: outcome.written,
        kept: outcome.kept,
        next_steps: nextSteps,
      },
      [],
    );
  } else {
    console.error("  next steps:");
    for (const line of nextSteps) console.error(`    ${line}`);
  }
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
  // A deployment's credentials are kept in a file the person names: it has no default one.
  if (!dev && opts.envFile === undefined) {
    failUsage(
      `${kind} for a deployment keeps its credentials in a file you name, since a deployment has no default one: ` +
        `pass --env-file <file> (it is created when missing)`,
    );
  }
  enterEnvFile(opts.envFile, { defaultFile: dev, mayCreate: true });
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

async function recordUrl(name: string, dirArg: string, opts: ChannelsSetupOptions): Promise<void> {
  if (name !== "slack" && name !== "lark") {
    failUsage(`${name}: only slack and lark have a URL a person sets (the instance points the others itself)`);
  }
  if (opts.config === undefined)
    failUsage("--record-url writes into the configuration a deploy delivers: pass --config <file>");
  const agentDir = agentDirOrExit(resolve(dirArg));
  selectAgentEnvironment("production");
  enterEnvFile(opts.envFile, { defaultFile: false });
  // The deployment's /health and the platform are reached as the instance's values and environment say, a proxy included.
  enterAgentEnv(agentDir);
  const config = resolve(opts.config);
  const source = await readInstanceConfigFile(config).catch(failStartup);
  const named = (source.values as { http?: { publicUrl?: unknown } }).http?.publicUrl;
  const configured = typeof named === "string" ? stripTrailingSlashes(named) : undefined;
  // `--url` is where this machine reads the deployment's /health; the URL the box confirms is the configuration's
  // own http.publicUrl when it names one, the one the platforms reach.
  const reach = (opts.url === undefined ? undefined : stripTrailingSlashes(opts.url)) ?? configured;
  const base = configured ?? reach;
  if (reach === undefined || base === undefined) {
    failUsage(`${config} names no http.publicUrl: pass --url <the deployment's public URL>`);
  }
  // The app's credentials are the file `--env-file` names, and the environment only with `--from-env`, as for `deploy`:
  // a bot token exported in the shell for the development app must not be the one a production URL is recorded against.
  if (opts.envFile === undefined && !opts.fromEnv) {
    failUsage(
      "--record-url finds the app its URL belongs to by its credentials, and a deployment has no default file: pass " +
        "--env-file <file> (the one `channels setup` kept them in), or --from-env for this command's environment",
    );
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
  const given = opts.fromEnv ? Object.entries(process.env) : [...loadEnvValues(namedValueFile() as string)];
  const values = new Map(given.flatMap(([n, v]) => (v === undefined ? [] : [[n, v] as const])));
  await recordChannelUrl(agentDir, config, kind, url, values).catch(failStartup);
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
