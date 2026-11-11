/**
 * `fastagent deploy <host> [agent]`: generate host artifacts from the resolved definition and print an ordered deploy
 * runbook.
 */
import { join, resolve } from "node:path";
import type { DeployHost } from "../../deploy/hosts.ts";
import { loadDotEnv } from "../../env.ts";
import { unmarkDevServe } from "../../serving-command.ts";
import { channelAppNames, prepareChannelApps, unpreparedChannelApps } from "./deploy/channel-apps.ts";
import { displayPath, readTextIfExists, selectAgentEnvironment } from "../../paths.ts";
import { buildProject } from "../../harnesses/pi-durable/build.ts";
import { deploymentName } from "../../deploy/deployment-name.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { apiReport, deploymentApi } from "../../deploy/api.ts";
import { API_KEY_VARIABLE, apiKeysFrom } from "../../http/server.ts";
import { readInstanceConfigFile, resolveConfig } from "../../harnesses/pi-durable/config.ts";
import { loadSourceDefinition } from "../../harnesses/pi-durable/open.ts";
import { failStartup, failUsage } from "../fail.ts";
import { shellArg } from "../../shell-arg.ts";
import { enterAgentDirectory, isInteractive } from "../shared.ts";
import {
  type Ticket,
  type TicketStep,
  checkTicket,
  printReport,
  refusedCheck,
  runTicket,
  startTicket,
  stopTicket,
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
  hostOnlyFlag({
    flag: "--idle-timeout",
    owner: "agentcore",
    passed: (opts: DeployOptions) => opts.idleTimeout !== undefined,
    instead: {
      docker: "ignored for local Docker: the container runs until it is stopped",
      fly: "ignored for Fly: a machine's idle behaviour is fly.toml's auto_stop_machines",
      railway: "ignored for Railway: a service runs until it is stopped",
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

/**
 * A manifest an earlier version generated under a name no instance has is not read any more, so a hand edit in it would
 * be lost without a word: say so once, naming the file that replaces it.
 */
async function warnLegacyManifest(agentDir: string, name: string, target: HostDeploy): Promise<void> {
  const { file, generated, renamed } = target.legacyManifest;
  if (file === "") return;
  const text = await readTextIfExists(join(agentDir, file)).catch(failStartup);
  if (text === undefined || !generated(text)) return;
  console.error(
    `[fastagent] warn: ${file} was generated by an earlier version and is no longer read: this instance's manifest is ` +
      `${renamed(name)}. Rename ${file} to keep edits made in it, or delete it.`,
  );
}

/** The command that reads a deploy's ticket, as every such ticket records it. */
const deployCheck = (host: DeployHost) => `fastagent deploy ${host} --check`;

/** How long a coding agent's deploy stays open: a build, and the person's steps between. */
const TICKET_TIMEOUT_SECONDS = 3600;

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  if (opts.check !== undefined) return checkDeploy(host, opts.check, opts);
  if (opts.stop) failUsage("--stop stops a deploy started with --json: pass --check <ticket> too");
  if (opts.ticket !== undefined) {
    // The process `startTicket` started: it takes the ticket before the pre-flight (seconds of building the
    // definition), then does the whole deploy, its person the ticket's.
    await runTicket(opts.ticket, (step) => deploy(host, dirArg, opts, step));
    process.exit(0);
  }
  await deploy(host, dirArg, opts);
}

/** The deploy itself: through a ticket's `step` when one runs it, else at this terminal or with nobody to ask. */
async function deploy(
  host: DeployHost,
  dirArg: string,
  opts: DeployOptions,
  step?: TicketStep,
): Promise<{ url?: string; notes: string[] }> {
  if (opts.code !== undefined) failUsage("--code hands a code to a deploy's ticket: pass --check <ticket> too");
  if (opts.json && !opts.run) failUsage("--json reports a deploy --run drives: pass --run too");
  selectAgentEnvironment("production");
  // The configuration the box runs on: the program's defaults, with the instance configuration `--config` delivers,
  // and never the project's own `fastagent.json`, the development instance's.
  const delivered =
    opts.config === undefined
      ? undefined
      : await readInstanceConfigFile(resolve(opts.config))
          .then((source) => ({ source }))
          .catch(failStartup);
  const deployed = async (dir: string) => ({
    definition: await loadSourceDefinition(dir),
    ...(delivered === undefined ? {} : { instance: delivered.source }),
  });
  // A deployment has no default value file: its values are this command's environment, with the file `--env-file`
  // names laid under it.
  const { agentDir } = await enterAgentDirectory(
    dirArg,
    { ...opts, deployment: true, instance: opts.envFile === undefined ? {} : { envFile: opts.envFile } },
    undefined,
    deployed,
  ).catch(failStartup);
  const name = await deploymentName(agentDir, opts.config).catch(failStartup);
  const config = await deployed(agentDir)
    .then(({ definition }) => resolveConfig(definition, delivered?.source))
    .catch(failStartup);
  // Never `dev`, whatever spawned this: a channel's way of receiving is chosen as the box will choose it.
  unmarkDevServe();
  const api = deploymentApi({ config, hostServes: host !== "agentcore" });
  const target = HOSTS[host];
  await warnLegacyManifest(agentDir, name, target);
  const preflight = async () => {
    const facts = await preflightDeploy({
      agentDir,
      name,
      config,
      ...(delivered === undefined ? {} : { delivered }),
      run: !!opts.run,
      force: !!opts.force,
      noResidentProcess: host === "agentcore", // alarms and webhooks wake the container there — no machine to keep up
      // Every AgentCore deployment starts the storage over (core.md §9).
      storageResets: host === "agentcore",
      servesApi: api.served,
      fromEnv: !!opts.fromEnv,
    }).catch(failStartup);
    if (!facts.ok) failStartup(new Error(`deploy stopped: ${facts.gate}`));
    target.validate?.({ opts, agentDir, name, pre: facts });
    return facts;
  };
  let pre = await preflight();
  const agentArg = displayPath(process.cwd(), agentDir);
  const rerun =
    `fastagent deploy ${host}${agentArg === undefined ? "" : ` ${shellArg(agentArg)}`}` +
    `${opts.config === undefined ? "" : ` --config ${shellArg(opts.config)}`}` +
    `${opts.envFile === undefined ? "" : ` --env-file ${shellArg(opts.envFile)}`}` +
    `${opts.fromEnv ? " --from-env" : ""}` +
    `${opts.intoLinked ? " --into-linked" : ""}${opts.idleTimeout === undefined ? "" : ` --idle-timeout ${opts.idleTimeout}`} --run`;
  const unprepared = opts.run ? unpreparedChannelApps(pre.channels, pre.values) : [];

  if (opts.json && step === undefined) {
    // A coding agent's deploy: what this machine can refuse is refused above, at once; the rest runs in a ticket.
    const timeout = opts.timeout === undefined ? TICKET_TIMEOUT_SECONDS : Number(opts.timeout);
    if (!Number.isInteger(timeout) || timeout <= 0) failUsage("--timeout must be a whole number of seconds");
    const ticket = await startTicket({
      subject: `deploy:${host}:${agentDir}`,
      fields: { deployment: host },
      action: `deploy the agent to ${host}`,
      check: deployCheck(host),
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
          ...(opts.force ? ["--force"] : []),
          ...(delivered === undefined ? [] : ["--config", delivered.source.label]),
          ...(opts.envFile === undefined ? [] : ["--env-file", opts.envFile]),
          ...(opts.fromEnv ? ["--from-env"] : []),
          ...(opts.intoLinked ? ["--into-linked"] : []),
          ...(opts.idleTimeout === undefined ? [] : ["--idle-timeout", opts.idleTimeout]),
          "--run",
          "--json",
        ],
        cwd: process.cwd(),
      },
    });
    reportDeploy(ticket, "started");
    process.exit(ticketExitCode(ticket));
  }

  /** Everything past the pre-flight, its person's steps taken by `answerer`; the URL and what the API report says. */
  const deployWith = async (answerer: Answerer): Promise<{ url?: string; notes: string[] }> => {
    if (unprepared.length > 0) {
      const supplied = unprepared.flatMap(channelAppNames);
      const kinds = unprepared.map(({ kind }) => kind);
      const { values } = pre;
      const absent = supplied.filter((name) => !values.get(name)?.trim());
      if (host === "docker" && unprepared.some(({ way }) => way === "webhook")) {
        failStartup(
          new Error(
            `deploy stopped: ${kinds.join(", ")} receive by webhook here, and this Docker deployment has no ` +
              `public URL to point the app at — set up your own ingress and supply ${absent.join(", ")} from a separate production app in ${pre.valuesFrom}, or ` +
              `set ${kinds.map((kind) => `channels.${kind}.ingress`).join(", ")} to "connection" in the configuration ` +
              `--config delivers`,
          ),
        );
      }
      // The credentials of the app it makes are kept in a file, and a deployment has no default one.
      if (opts.envFile === undefined) {
        const config = opts.config === undefined ? "" : ` --config ${shellArg(opts.config)}`;
        failUsage(
          `deploy stopped: ${absent.join(", ")} are not in ${pre.valuesFrom}, so a production ${kinds.join(" and ")} app ` +
            `has to be made, and its credentials need a file to be kept in. Make it with ` +
            `\`fastagent channels setup ${kinds[0]} --env-file <file>${config}\` (it creates the file), then deploy ` +
            `again with --env-file <file>; or supply them in the environment of this command and pass --from-env`,
        );
      }
      if (answerer.kind === "nobody") {
        failUsage(
          `deploy stopped: ${pre.valuesFrom} has no ${absent.join(", ")}: setting up the separate production app ` +
            `needs a person — run this deploy in a terminal; from a coding agent, run \`${rerun} --json\`, which ` +
            `hands their part to its user`,
        );
      }
      const again = answerer.kind === "ticket" ? `${rerun} --json` : rerun;
      await prepareChannelApps(
        agentDir,
        resolve(opts.envFile),
        unprepared,
        again,
        answerer.kind === "ticket" ? answerer.step.person : undefined,
      ).catch(failStartup);
      // What the setup kept is this deploy's values from here on.
      loadDotEnv(agentDir);
      pre = await preflight();
    }
    for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
    // The box starts the build, never the source: dist/ is made here, from what the image will hold.
    const built = await buildProject(agentDir).catch(failStartup);
    for (const warning of built.warnings) console.error(`[fastagent] warn: ${warning}`);
    const { channels } = pre;
    warnHostOnlyFlags(host, opts);
    // What follows is the host's work: a deadline meant for the person must never cut it halfway. Its own steps for
    // the person (a host sign-in, the box's login) wait again, and are bounded again.
    if (answerer.kind === "ticket") answerer.step.person.carriesOn();
    const reachedAt = await target.deploy({
      opts,
      answerer,
      rerun,
      agentDir,
      name,
      config,
      pre,
      api,
      channels,
      webhookChannels: channels.filter((channel) => channel.ingress === "webhook"),
      // The ownership predicate is bound HERE, from the same lookup that chose the host, so no host module can pass
      // one.
      // Reporting a stale artifact is enough when only generating them — the operator reads the line and decides. But
      // `--run` would then deploy FROM it: a determinate mismatch between what ships and what the definition says
      // (a configuration the manifest does not carry), and gated the same way. `--force` regenerates ours; a file we
      // did not generate is never touched by either, and the marker line is how an operator takes a path back on
      // purpose.
      write: async (artifacts, options) => {
        const plan = await planArtifacts(agentDir, artifacts, { ...options, isOurs: target.isOurs });
        if (opts.run && plan.stale.length > 0) {
          failStartup(
            new Error(
              `deploy stopped: ${plan.stale.join(", ")} no longer match what this definition generates (the ` +
                `instance's configuration is rendered into them), and --run would deploy from them. Re-run with ` +
                `--force to regenerate, or remove each file's generated-by marker to own it yourself.`,
            ),
          );
        }
        await applyArtifactPlan(plan);
      },
    });
    const keyHere = apiKeysFrom(pre.values.get(API_KEY_VARIABLE)).length > 0;
    const notes = apiReport(api, { valuesFrom: pre.valuesFrom, agentArg, keyHere, run: !!opts.run }, reachedAt);
    for (const line of notes) console.error(`[fastagent] ${line}`);
    return { ...(reachedAt === undefined ? {} : { url: reachedAt }), notes };
  };

  if (step !== undefined) return deployWith({ kind: "ticket", step });
  return deployWith(opts.input === false || !isInteractive() ? { kind: "nobody" } : { kind: "terminal" });
}

/** `deploy <host> --check <ticket> [--code <code>]`. */
async function checkDeploy(host: DeployHost, id: string, opts: DeployOptions): Promise<void> {
  const refused = refusedCheck(id, deployCheck(host));
  if (refused !== undefined) failUsage(refused);
  // There: refusedCheck read it, and a ticket is pruned only a day after it ends.
  const ticket = opts.stop ? await stopTicket(id) : ((await checkTicket(id, opts.code)) as Ticket);
  reportDeploy(ticket, "checked");
  process.exit(ticketExitCode(ticket));
}

/** A deploy's ticket for the agent that started or checked it, always as JSON: `--json` is how one started. */
function reportDeploy(ticket: Ticket, when: "started" | "checked"): void {
  const report = ticketReport(ticket, when, (result) => ({
    fields: result,
    text: [],
    next:
      result.url === undefined
        ? "Deployed. Tell the user what the notes say."
        : `Deployed to ${String(result.url)}. Tell the user what the notes say.`,
  }));
  const running = ticket.status === "starting" || ticket.status === "working" || ticket.status === "need_user_action";
  if (!running) {
    printReport(true, report.json, []);
    return;
  }
  // A deploy finishing is never cut by its deadline, so one that hangs there ends only on someone's say.
  const stop = `${ticket.check} ${ticket.ticket} --stop --json`;
  const hung =
    ticket.status === "need_user_action"
      ? ""
      : " If its log has shown no progress for a long while, stop_command stops it where it is, which can leave the " +
        "host half-changed: ask the user first.";
  printReport(
    true,
    { ...report.json, stop_command: stop, agent_next_steps: `${String(report.json.agent_next_steps)}${hung}` },
    [],
  );
}
