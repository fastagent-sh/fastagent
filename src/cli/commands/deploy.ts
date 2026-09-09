/**
 * `fastagent deploy <host> [dir]`: generate host artifacts from the resolved definition and print an ordered deploy
 * runbook.
 */
import type { DeployHost } from "../../deploy/hosts.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { loadConfig, resolveModelSpec } from "../../engines/pi/config.ts";
import { failStartup, failUsage } from "../fail.ts";
import { enterAgentCommand } from "../shared.ts";
import { agentcoreHost } from "./deploy/agentcore.ts";
import { dockerHost } from "./deploy/docker.ts";
import { flyHost } from "./deploy/fly.ts";
import { railwayHost } from "./deploy/railway.ts";
import { type DeployOptions, type HostDeploy, writeArtifacts } from "./deploy/shared.ts";

export { writeArtifacts };

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
    flag: "--stop/--no-scale-to-zero",
    owner: "fly",
    passed: (opts: DeployOptions) => opts.stop === true || opts.scaleToZero === false,
    instead: {
      docker: "local Compose stays running",
      railway: "Railway's App Sleeping is a dashboard toggle (the runbook states the manual step)",
      agentcore: "AgentCore's idle/lifetime policy lives in the template's LifecycleConfiguration",
    },
  }),
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
    // A colon, not "is": one row names a single flag and the other names a pair, and no verb agrees with both (the
    // hand-written copies this replaced said "is" and "are" respectively).
    console.error(`[fastagent] warn: ${rule.flag}: ${rule.owner}-only — ${instead}`);
  }
}

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  if (opts.tunnel && host !== "docker") {
    // A flag/host combination the parser cannot see (host is an argument) — usage class, exit 2.
    failUsage(`deploy stopped: --tunnel is supported only by the local Docker target`);
  }
  // The picker's write-back lands the model in fastagent.config.*.
  const placement = await enterAgentCommand(dirArg, opts);
  // ONE deploy semantic: bake the WORKSPACE (WYSIWYG).
  const { agentDir, workspace } = placement;
  const { config } = await loadConfig(agentDir).catch(failStartup);
  const modelSpec = resolveModelSpec(opts.model, config);
  // The host-neutral pre-flight (model-travel gate, channel discovery, model-auth probe, container facts + their
  // warnings) lives in deploy/preflight.ts.
  const pre = await preflightDeploy({
    placement,
    config,
    modelSpec,
    run: !!opts.run,
    force: !!opts.force,
    externalClock: host === "agentcore", // cron rides EventBridge there — the resident-host notes don't apply
    authPathFlag: opts.authPath, // flag > FASTAGENT_AUTH_PATH > default — resolved by preflight (one owner)
  }).catch(failStartup);
  if (!pre.ok) failStartup(new Error(`deploy stopped: ${pre.gate}`));
  for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
  const { channels } = pre;
  warnHostOnlyFlags(host, opts);
  const target = HOSTS[host];
  await target.deploy({
    opts,
    agentDir,
    workspace,
    config,
    pre,
    channels,
    webhookChannels: channels.filter((channel) => channel.ingress === "webhook"),
    longConnectionChannels: channels.filter((channel) => channel.ingress === "long-connection"),
    // The ownership predicate is bound HERE, from the same lookup that chose the host, so no host module can pass
    // one.
    write: (artifacts, options) => writeArtifacts(workspace, artifacts, { ...options, isOurs: target.isOurs }),
  });
}
