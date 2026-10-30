/**
 * `fastagent deploy <host> [agent]`: generate host artifacts from the resolved definition and print an ordered deploy
 * runbook.
 */
import { relative } from "node:path";
import type { DeployHost } from "../../deploy/hosts.ts";
import { cloudFor } from "../../channels/feishu/cloud.ts";
import { FEISHU_INGRESS_SETTINGS } from "../../channels/feishu/setup-mode.ts";
import { assembleSecrets, divergentSettingsGate, missingValuesGate } from "../../deploy/secrets.ts";
import { dotEnvPath, loadEnvValues } from "../../env.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import {
  assertIndependentFeishuApps,
  feishuAppSecretNames,
  larkCredentialsNeeded,
  prepareFeishuApps,
  unpreparedFeishuApps,
} from "../add-feishu.ts";
import { displayPath, selectAgentEnvironment } from "../../paths.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { apiReport, deploymentApi, writeApiKey } from "../../deploy/api.ts";
import { unprotectedSecretsNote } from "../../value-file.ts";
import { loadConfig } from "../../harnesses/pi-durable/open.ts";
import { failStartup, failUsage } from "../fail.ts";
import { enterAgentDirectory, isInteractive, shellArg } from "../shared.ts";
import { terminalPerson } from "../person.ts";
import {
  type Ticket,
  checkTicket,
  printReport,
  runTicket,
  startTicket,
  ticketExitCode,
  ticketReport,
} from "../ticket.ts";
import { agentcoreHost } from "./deploy/agentcore.ts";
import { dockerHost } from "./deploy/docker.ts";
import { flyHost } from "./deploy/fly.ts";
import { railwayHost } from "./deploy/railway.ts";
import {
  type Answerer,
  type DeployOptions,
  type HostDeploy,
  applyArtifactPlan,
  planArtifacts,
} from "./deploy/shared.ts";

export { applyArtifactPlan, planArtifacts };

/** Every host, by the name the CLI takes. */
export const HOSTS: Record<DeployHost, HostDeploy> = {
  docker: dockerHost,
  fly: flyHost,
  railway: railwayHost,
  agentcore: agentcoreHost,
};

/** A flag exactly one host honours, and what the OTHERS do instead. */
interface HostOnlyFlag<Owner extends DeployHost> {
  flag: string;
  owner: Owner;
  passed: (opts: DeployOptions) => boolean;
  instead: Record<Exclude<DeployHost, Owner>, string>;
}

/** Infers `Owner` from the literal's own `owner`, so each row carries its exhaustiveness itself. */
const hostOnlyFlag = <Owner extends DeployHost>(rule: HostOnlyFlag<Owner>): HostOnlyFlag<Owner> => rule;

/** ONE table for "this flag belongs to that host", because the fact is symmetric and was not stored that way. */
export const HOST_ONLY_FLAGS = [
  hostOnlyFlag({
    flag: "--into-linked",
    owner: "railway",
    passed: (opts: DeployOptions) => opts.intoLinked === true,
    instead: {
      docker: "ignored for local Docker",
      agentcore: "ignored for AgentCore",
      fly: "fly --run is idempotent — it reuses an existing app/volume",
    },
  }),
];

/**
 * Exported for its own test: nothing covered these six sentences, which is how three of them came to disagree about
 * the spelling of a host name.
 */
export function warnHostOnlyFlags(host: DeployHost, opts: DeployOptions): void {
  for (const rule of HOST_ONLY_FLAGS) {
    if (host === rule.owner || !rule.passed(opts)) continue;
    // The `continue` above is exactly the key set `instead` is typed over, but TS cannot narrow a union member out
    // through a comparison against a per-rule literal, so the read needs a cast — and a cast is how a hole would
    // reach the operator as the word "undefined".
    const instead: string | undefined = (rule.instead as Record<string, string>)[host];
    // THROWN, not `failStartup`ed, though every other failure in this file exits through that.
    if (instead === undefined) {
      throw new Error(`deploy: HOST_ONLY_FLAGS has no "instead" line for ${host} on ${rule.flag}`);
    }
    // A colon, not "is": one row names a single flag and the other names a pair, and no verb agrees with both.
    console.error(`[fastagent] warn: ${rule.flag}: ${rule.owner}-only — ${instead}`);
  }
}

/** How long a coding agent's deploy stays open: a build, and the person's steps between. */
const TICKET_TIMEOUT_SECONDS = 3600;

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  if (opts.check !== undefined) return checkDeploy(host, opts.check, opts);
  if (opts.code !== undefined) failUsage("--code hands a code to a deploy's ticket: pass --check <ticket> too");
  if (opts.tunnel && host !== "docker") {
    // A flag/host combination the parser cannot see (host is an argument) — usage class, exit 2.
    failUsage(`deploy stopped: --tunnel is supported only by the local Docker target`);
  }
  if (opts.json && !opts.run) failUsage("--json reports a deploy --run drives: pass --run too");
  selectAgentEnvironment("production");
  const { agentDir } = await enterAgentDirectory(dirArg, opts);
  const config = await loadConfig(agentDir).catch(failStartup);
  // Never `dev`, whatever spawned this; and what decides a channel's shape is read here as the box will read it.
  unmarkDevServe();
  const shaped = divergentSettingsGate(
    FEISHU_INGRESS_SETTINGS,
    process.env,
    loadEnvValues(dotEnvPath(agentDir)),
    relative(agentDir, dotEnvPath(agentDir)),
  );
  if (shaped) failStartup(new Error(`deploy stopped: ${shaped}`));
  const independentApps = (values: ReadonlyMap<string, string>) => {
    try {
      assertIndependentFeishuApps(agentDir, ["feishu", "lark"], values);
    } catch (error) {
      failStartup(error);
    }
  };
  independentApps(loadEnvValues(dotEnvPath(agentDir)));
  const api = deploymentApi({
    config,
    hostServes: host !== "agentcore",
    values: loadEnvValues(dotEnvPath(agentDir)),
  });
  const target = HOSTS[host];
  const preflight = async () => {
    const facts = await preflightDeploy({
      agentDir,
      config,
      run: !!opts.run,
      force: !!opts.force,
      noResidentProcess: host === "agentcore", // alarms and webhooks wake the container there — no machine to keep up
      // Every AgentCore deployment starts the storage over (core.md §9).
      storageResets: host === "agentcore",
      servesApi: api.served,
    }).catch(failStartup);
    if (!facts.ok) failStartup(new Error(`deploy stopped: ${facts.gate}`));
    target.validate?.({ opts, agentDir, pre: facts });
    return facts;
  };
  let pre = await preflight();
  const agentArg = displayPath(process.cwd(), agentDir);
  const rerun =
    `fastagent deploy ${host}${agentArg === undefined ? "" : ` ${shellArg(agentArg)}`}` +
    `${opts.tunnel ? " --tunnel" : ""}${opts.intoLinked ? " --into-linked" : ""} --run`;
  const unprepared = opts.run ? unpreparedFeishuApps(pre.channels, pre.values) : [];

  if (opts.json && opts.ticket === undefined) {
    // A coding agent's deploy: what this machine can refuse is refused above, at once; the rest runs in a ticket.
    if (unprepared.some(({ kind }) => kind === "lark")) {
      const needed = await larkCredentialsNeeded(agentDir, rerun).catch(failStartup);
      if (needed !== undefined) {
        printReport(true, needed.json, needed.text);
        process.exit(0);
      }
    }
    const timeout = opts.timeout === undefined ? TICKET_TIMEOUT_SECONDS : Number(opts.timeout);
    if (!Number.isInteger(timeout) || timeout <= 0) failUsage("--timeout must be a whole number of seconds");
    const ticket = await startTicket({
      subject: `deploy:${host}:${agentDir}`,
      action: `deploy the agent to ${host}`,
      check: `fastagent deploy ${host} --check`,
      restart: rerun,
      timeoutSeconds: timeout,
      waitsFirst: false,
      // A deploy stopped halfway leaves the host half-changed: one already running is the answer.
      whenRunning: "join",
      command: {
        file: process.execPath,
        args: [
          ...process.execArgv,
          process.argv[1] as string,
          "deploy",
          host,
          agentDir,
          ...(opts.tunnel ? ["--tunnel"] : []),
          ...(opts.force ? ["--force"] : []),
          ...(opts.intoLinked ? ["--into-linked"] : []),
          "--run",
          "--json",
        ],
        cwd: process.cwd(),
      },
    });
    reportDeploy(ticket, host, "started");
    process.exit(ticketExitCode(ticket));
  }

  /** Everything past the pre-flight, its person's steps taken by `answerer`; the URL and what the API report says. */
  const deployWith = async (answerer: Answerer): Promise<{ url?: string; notes: string[] }> => {
    if (unprepared.length > 0) {
      const supplied = unprepared.flatMap(({ kind, ingress }) => feishuAppSecretNames(kind, ingress));
      const kinds = unprepared.map(({ kind }) => kind);
      const { values } = pre;
      const absent = supplied.filter((name) => !values.get(name)?.trim());
      const { missingSecrets } = assembleSecrets({
        modelAuth: pre.modelAuth,
        declared: pre.declaredSecrets,
        values: pre.values,
      });
      const missing = missingValuesGate(
        missingSecrets.filter((name) => !supplied.includes(name)),
        pre.valueFile,
      );
      if (missing) failStartup(new Error(`deploy stopped: ${missing}`));
      if (host === "docker" && !opts.tunnel && unprepared.some(({ ingress }) => ingress === "webhook")) {
        failStartup(
          new Error(
            `deploy stopped: ${kinds.join(", ")} receive by webhook here, and this Docker deployment has no ` +
              `public URL to point the app at — re-run with --tunnel (the app is prepared then), or set up your own ` +
              `ingress and supply ${absent.join(", ")} from a separate production app in ${pre.valueFile}, or ` +
              `set ${kinds.map((kind) => `${cloudFor(kind).envPrefix}_INGRESS=websocket`).join(", ")} there`,
          ),
        );
      }
      if (answerer.kind === "nobody") {
        failUsage(
          `deploy stopped: ${pre.valueFile} has no ${absent.join(", ")}: setting up the separate production app ` +
            `needs a person — run this deploy in a terminal; from a coding agent, run \`${rerun} --json\`, which ` +
            `hands their part to its user`,
        );
      }
      const person = answerer.kind === "ticket" ? answerer.step.person : terminalPerson;
      const again = answerer.kind === "ticket" ? `${rerun} --json` : rerun;
      await prepareFeishuApps(agentDir, unprepared, again, person).catch(failStartup);
      pre = await preflight();
    }
    independentApps(pre.values);
    if (api.served && api.generatesKey) {
      // Past every refusal the pre-flight makes, and read again, so this deploy carries it.
      const unprotected = await writeApiKey(agentDir).catch(failStartup);
      if (unprotected !== undefined) console.error(`[fastagent] note: ${unprotectedSecretsNote(unprotected)}`);
      pre = await preflight();
    }
    for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
    const { channels } = pre;
    warnHostOnlyFlags(host, opts);
    const reachedAt = await target.deploy({
      opts,
      answerer,
      agentDir,
      config,
      pre,
      channels,
      webhookChannels: channels.filter((channel) => channel.ingress === "webhook"),
      // The ownership predicate is bound HERE, from the same lookup that chose the host, so no host module can pass
      // one.
      // Reporting a stale artifact is enough when only generating them — the operator reads the line and decides. But
      // `--run` would then deploy FROM it: a determinate mismatch between what ships and what the definition says,
      // the same class as a Dockerfile that cannot read the manifest, and gated the
      // same way. `--force` regenerates ours; a file we did not generate is never touched by either, and the marker
      // line is how an operator takes a path back on purpose.
      write: async (artifacts, options) => {
        const plan = await planArtifacts(agentDir, artifacts, { ...options, isOurs: target.isOurs });
        if (opts.run && plan.stale.length > 0) {
          failStartup(
            new Error(
              `deploy stopped: ${plan.stale.join(", ")} no longer match what this definition generates, and --run ` +
                `would deploy from them. Re-run with --force to regenerate, or remove each file's generated-by ` +
                `marker to own it yourself.`,
            ),
          );
        }
        await applyArtifactPlan(plan);
      },
    });
    const notes = apiReport(api, { valueFile: pre.valueFile, agentArg }, reachedAt);
    for (const line of notes) console.error(`[fastagent] ${line}`);
    return { ...(reachedAt === undefined ? {} : { url: reachedAt }), notes };
  };

  if (opts.ticket !== undefined) {
    // The process `startTicket` started: the deploy itself, its person the ticket's.
    await runTicket(opts.ticket, (step) => deployWith({ kind: "ticket", step }));
    process.exit(0);
  }
  await deployWith(opts.input === false || !isInteractive() ? { kind: "nobody" } : { kind: "terminal" });
}

/** `deploy <host> --check <ticket> [--code <code>]`. */
async function checkDeploy(host: DeployHost, id: string, opts: DeployOptions): Promise<void> {
  const ticket = await checkTicket(id, opts.code);
  if (ticket === undefined) failUsage(`no deploy "${id}": a ticket is what \`fastagent deploy --run --json\` printed`);
  reportDeploy(ticket, host, "checked");
  process.exit(ticketExitCode(ticket));
}

/** A deploy's ticket for the agent that started or checked it, always as JSON: `--json` is how one started. */
function reportDeploy(ticket: Ticket, host: DeployHost, when: "started" | "checked"): void {
  const { json } = ticketReport(ticket, when, (result) => ({
    fields: result,
    text: [],
    next:
      result.url === undefined
        ? "Deployed. Tell the user what the notes say."
        : `Deployed to ${String(result.url)}. Tell the user what the notes say.`,
  }));
  printReport(true, { ...json, deployment: host }, []);
}
