/**
 * `fastagent channels setup <name> --record-url`: record, in the configuration a deploy delivers, the URL a person set
 * on a Slack or Lark app's page, once the deployment confirms the platform reaches it there (channel-setup.md §5).
 */
import { resolve } from "node:path";
import { recordChannelUrl } from "../channel-app.ts";
import { type WebhookKind, webhookPath } from "../../channels/webhooks.ts";
import { readInstanceConfigFile } from "../../harnesses/pi-durable/config.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { dotEnvPath, loadEnvValues } from "../../value-file.ts";
import { agentDirOrExit, failStartup, failUsage } from "../fail.ts";
import { printReport } from "../ticket.ts";

export interface ChannelsSetupOptions {
  recordUrl: boolean;
  config?: string;
  url?: string;
  app?: string;
  team?: string;
  json: boolean;
}

export async function runChannelsSetup(name: string, dirArg: string, opts: ChannelsSetupOptions): Promise<void> {
  if (!opts.recordUrl) {
    failUsage(
      "channels setup records the URL a person set on an app's page in this release: pass --record-url " +
        "(`fastagent add <channel>` sets up the app itself)",
    );
  }
  if (name !== "slack" && name !== "lark") {
    failUsage(`${name}: only slack and lark have a URL a person sets (the instance points the others itself)`);
  }
  if (opts.config === undefined)
    failUsage("--record-url writes into the configuration a deploy delivers: pass --config <file>");
  const agentDir = agentDirOrExit(resolve(dirArg));
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
  if (opts.team !== undefined && opts.app === undefined) failUsage("--team names the app's workspace: pass --app too");
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
  selectAgentEnvironment("production");
  const app =
    opts.app === undefined ? undefined : { id: opts.app, ...(opts.team === undefined ? {} : { team: opts.team }) };
  await recordChannelUrl(agentDir, config, kind, url, loadEnvValues(dotEnvPath(agentDir)), app).catch(failStartup);
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
