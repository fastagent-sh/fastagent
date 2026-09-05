/**
 * `fastagent deploy <host> [dir]`: generate host artifacts from the resolved definition and print an
 * ordered deploy runbook. Host-scoped (`docker` | `fly` | `railway` — the extension seam). It does NOT
 * run the host CLI by default: fastagent owns the definition-aware artifacts and precise runbook;
 * Docker may opt into a generated ephemeral tunnel, while durable ingress stays operator-owned. The pre-flight
 * (config/model/channels/container facts) is host-neutral; each host's module (`./deploy/<host>.ts`)
 * adds its artifacts, its kept-file semantics, its gates and its `--run` drive over the neutral
 * `deploy/<host>/` plan + driver. Read-only on the definition; the only writes are generated
 * artifacts (never clobbered without --force). `--run` drives the target CLI instead of printing.
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

/** Every host, by the name the CLI takes. Typed over {@link DeployHost} so a host added to the list
 *  without a module here fails to compile. */
export const HOSTS: Record<DeployHost, HostDeploy> = {
  docker: dockerHost,
  fly: flyHost,
  railway: railwayHost,
  agentcore: agentcoreHost,
};

/** A flag exactly one host honours, and what the OTHERS do instead. `instead` is exhaustive over the
 *  non-owners, so a host added to `DEPLOY_HOSTS` cannot silently lose its line. */
interface HostOnlyFlag<Owner extends DeployHost> {
  flag: string;
  owner: Owner;
  passed: (opts: DeployOptions) => boolean;
  instead: Record<Exclude<DeployHost, Owner>, string>;
}

/** Infers `Owner` from the literal's own `owner`, so each row carries its exhaustiveness itself. The
 *  alternative — annotating the array as a tuple of `HostOnlyFlag<"fly"> | …` — put the whole guarantee
 *  in one annotation that a third rule invites relaxing to `HostOnlyFlag<DeployHost>[]`, where
 *  `Exclude<DeployHost, DeployHost>` collapses to `never` and every `instead` type-checks empty. */
const hostOnlyFlag = <Owner extends DeployHost>(rule: HostOnlyFlag<Owner>): HostOnlyFlag<Owner> => rule;

/**
 * ONE table for "this flag belongs to that host", because the fact is symmetric and was not stored
 * that way: each host branch stated the OTHER hosts' flags in its own words, so the same sentence
 * existed three times per flag and had already drifted (`Railway-only` twice, `railway-only` once).
 *
 * Every row is a flag that only WARNS elsewhere. `--tunnel` is host-only too and is deliberately not
 * here: it is a usage GATE (`failUsage`, exit 2) raised in `runDeploy`, not a warning — moving it in
 * would downgrade a refusal to a line of advice.
 *
 * Exported for the exhaustiveness test: the type stops a missing `instead` line, and the test stops it
 * from being typed away.
 */
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

/** Exported for its own test: nothing covered these six sentences, which is how three of them came to
 *  disagree about the spelling of a host name. */
export function warnHostOnlyFlags(host: DeployHost, opts: DeployOptions): void {
  for (const rule of HOST_ONLY_FLAGS) {
    if (host === rule.owner || !rule.passed(opts)) continue;
    // The `continue` above is exactly the key set `instead` is typed over, but TS cannot narrow a
    // union member out through a comparison against a per-rule literal, so the read needs a cast —
    // and a cast is how a hole would reach the operator as the word "undefined". Unreachable while
    // the rows stay exhaustive, which is what the table's own test asserts.
    const instead: string | undefined = (rule.instead as Record<string, string>)[host];
    // THROWN, not `failStartup`ed, though every other failure in this file exits through that: an
    // incomplete table is a bug, and fail.ts prints a plain Error's message WITHOUT its stack (it
    // reserves that shape for user-fixable problems) while exiting the process — which in the test
    // that covers this table would kill the worker instead of reporting which row is short.
    if (instead === undefined) {
      throw new Error(`deploy: HOST_ONLY_FLAGS has no "instead" line for ${host} on ${rule.flag}`);
    }
    // A colon, not "is": one row names a single flag and the other names a pair, and no verb agrees
    // with both (the hand-written copies this replaced said "is" and "are" respectively).
    console.error(`[fastagent] warn: ${rule.flag}: ${rule.owner}-only — ${instead}`);
  }
}

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  if (opts.tunnel && host !== "docker") {
    // A flag/host combination the parser cannot see (host is an argument) — usage class, exit 2.
    failUsage(`deploy stopped: --tunnel is supported only by the local Docker target`);
  }
  // The picker's write-back lands the model in fastagent.config.* — exactly what the model-travel
  // gate below requires (--model/env don't reach the deployed box) — and an inline login stores the
  // credential `--run` then carries. Runs BEFORE loadConfig; the read-back sees the rewritten file
  // because loadConfig cache-busts on mtime (a failed write-back still gates, correctly).
  const placement = await enterAgentCommand(dirArg, opts);
  // ONE deploy semantic: bake the WORKSPACE (WYSIWYG). Artifacts land under the agent dir
  // (`fastagent/`) plus the one workspace-root `.dockerignore` the packers require; host CLIs run
  // from the workspace, which is the build context.
  const { agentDir, workspace } = placement;
  const { config } = await loadConfig(agentDir).catch(failStartup);
  const modelSpec = resolveModelSpec(opts.model, config);
  // The host-neutral pre-flight (model-travel gate, channel discovery, model-auth probe, container facts +
  // their warnings) lives in deploy/preflight.ts — testable in isolation. The CLI prints its messages and
  // stops on its gate; the host branch below adds only the host-specific artifacts + runbook + run drive.
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
    // The ownership predicate is bound HERE, from the same lookup that chose the host, so no host
    // module can pass one — the four that did each stated theirs twice, in a position where a
    // neighbour's type-checks and silently makes `--force` a no-op for the host's own artifact.
    write: (artifacts, options) => writeArtifacts(workspace, artifacts, { ...options, isOurs: target.isOurs }),
  });
}
