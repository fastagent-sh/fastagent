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
  prepareFeishuApps,
  unpreparedFeishuApps,
} from "../add-feishu.ts";
import { selectAgentEnvironment } from "../../paths.ts";
import { preflightDeploy } from "../../deploy/preflight.ts";
import { loadConfig } from "../../harnesses/pi/config.ts";
import { failStartup, failUsage } from "../fail.ts";
import { enterAgentDirectory, isInteractive } from "../shared.ts";
import { agentcoreHost } from "./deploy/agentcore.ts";
import { dockerHost } from "./deploy/docker.ts";
import { flyHost } from "./deploy/fly.ts";
import { railwayHost } from "./deploy/railway.ts";
import { type DeployOptions, type HostDeploy, applyArtifactPlan, planArtifacts } from "./deploy/shared.ts";

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

export async function runDeploy(host: DeployHost, dirArg: string, opts: DeployOptions): Promise<void> {
  if (opts.tunnel && host !== "docker") {
    // A flag/host combination the parser cannot see (host is an argument) — usage class, exit 2.
    failUsage(`deploy stopped: --tunnel is supported only by the local Docker target`);
  }
  // The picker's write-back lands the model in fastagent.config.ts. ONE deploy semantic: bake the agent directory
  // (WYSIWYG).
  selectAgentEnvironment("production");
  const { agentDir } = await enterAgentDirectory(dirArg, opts);
  const { config } = await loadConfig(agentDir).catch(failStartup);
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
  const preflight = () =>
    preflightDeploy({
      agentDir,
      config,
      run: !!opts.run,
      force: !!opts.force,
      noResidentProcess: host === "agentcore", // alarms and webhooks wake the container there — no machine to keep up
      // AgentCore DOES get a public URL (the forwarder's, AuthType NONE) — but nothing of ours answers behind it:
      // that relay reaches the channels' routes only, each verifying its platform's signature (agentcore-service.ts).
      publicUrl: host !== "agentcore",
      // Every AgentCore deployment starts the storage over (core.md §9).
      storageResets: host === "agentcore",
    }).catch(failStartup);
  let pre = await preflight();
  if (!pre.ok) failStartup(new Error(`deploy stopped: ${pre.gate}`));
  const unprepared = opts.run ? unpreparedFeishuApps(pre.channels, pre.values) : [];
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
    if (opts.input === false || !isInteractive()) {
      failStartup(
        new Error(
          `deploy stopped: ${pre.valueFile} has no ${absent.join(", ")}: creating or preparing a separate ` +
            `production app needs a terminal — run this deploy in one${opts.input === false ? " without --no-input" : ""}, ` +
            `or supply these values from a production app in ${pre.valueFile}`,
        ),
      );
    }
    await prepareFeishuApps(
      agentDir,
      unprepared,
      `fastagent deploy ${host}${opts.tunnel ? " --tunnel" : ""} --run`,
    ).catch(failStartup);
    pre = await preflight();
    if (!pre.ok) failStartup(new Error(`deploy stopped: ${pre.gate}`));
  }
  independentApps(pre.values);
  for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
  const { channels } = pre;
  warnHostOnlyFlags(host, opts);
  const target = HOSTS[host];
  await target.deploy({
    opts,
    agentDir,
    config,
    pre,
    channels,
    webhookChannels: channels.filter((channel) => channel.ingress === "webhook"),
    longConnectionChannels: channels.filter((channel) => channel.ingress === "long-connection"),
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
}
