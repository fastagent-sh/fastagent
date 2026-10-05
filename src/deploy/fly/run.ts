/** `fastagent deploy fly --run` — drive flyctl to completion. */
import type { BoxLoginStep } from "../box-shell.ts";
import {
  type PublicHealthProbe,
  type Registrars,
  loginGate,
  publicHealthGate,
  registerWebhooks,
} from "../channel-ingress.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import { type CliRunner, readOutput } from "../runner.ts";
import { missingValuesGate } from "../secrets.ts";

export interface FlyRunPlan {
  appName: string;
  /** `KEY=value` secrets to set on Fly: the value file's variables. */
  secrets: Record<string, string>;
  /** Declared names the value file supplies no value for — the run gates on these before any side effect. */
  missingSecrets: string[];
  /** That value file, agent-dir-relative, so the gate names the file this deploy actually read. */
  valueFile: string;
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /** fly.toml path passed to `fly deploy -c` (relative to the run cwd = the agent directory). */
  flyConfig: string;
  /** Dockerfile path passed explicitly, relative to the run cwd (the build context). */
  dockerfile: string;
  /**
   * Log the box in (`fastagent login --deployment`) once it is up and before any webhook is pointed at it: a channel pointed at
   * a box with no model credential answers every message with a failure. Resolves a gate line, or undefined.
   */
  boxLogin?: BoxLoginStep;
}

/** Done, or a gate the operator must clear before re-running (printed + non-zero exit by the CLI). */
export type FlyRunOutcome = { ok: true } | { ok: false; gate: string };

/**
 * The `Type` values that put an app on `https://<app>.fly.dev`, BY FAMILY — one entry per allocate command, because
 * that is the granularity the answer is acted on at.
 */
const INGRESS_TYPES = { v4: ["v4", "shared_v4"], v6: ["v6"] } as const;

/**
 * Which PUBLIC ingress families `fly ips list --json` shows — asked per family, because "has an ingress address" is
 * not the question the two allocate commands answer.
 */
export function ingressAddresses(stdout: string): { v4: boolean; v6: boolean } {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  const has = (types: readonly string[]) =>
    (entries as { Address?: unknown; Type?: unknown }[]).some(
      (entry) => typeof entry?.Address === "string" && entry.Address !== "" && types.includes(entry.Type as string),
    );
  return { v4: has(INGRESS_TYPES.v4), v6: has(INGRESS_TYPES.v6) };
}

/**
 * Whether `fly apps list --json` lists an app called `name`. flyctl capitalizes the field; the live probe
 * (test/live/fly.live.test.ts) is what pins that against real output, since an offline fixture can only repeat what
 * we already believe.
 */
export function listHasName(stdout: string, name: string): boolean {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  return entries.some((o) => (o as { Name?: string }).Name === name);
}

export async function deployFlyRun(
  plan: FlyRunPlan,
  fly: CliRunner,
  log: (msg: string) => void,
  registrars: Registrars,
  healthProbe?: PublicHealthProbe,
): Promise<FlyRunOutcome> {
  const gate = (g: string): FlyRunOutcome => ({ ok: false, gate: g });

  // 1.
  if ((await fly(["auth", "whoami"], { capture: true })).code !== 0) {
    return gate("not logged in to Fly — run `fly auth login` (opens a browser), or set FLY_API_TOKEN, then re-run");
  }

  // 2. Gate missing required secret VALUES before any side effect (no half-created infra).
  const missingValues = missingValuesGate(plan.missingSecrets, plan.valueFile);
  if (missingValues) return gate(missingValues);

  // 3.
  const appExists = await readOutput(fly, "fly", ["apps", "list", "--json"], (out) => listHasName(out, plan.appName));
  if ("gate" in appExists) return gate(appExists.gate);
  if (appExists.value) {
    log(`app ${plan.appName} exists — skipping create`);
  } else {
    log(`creating app ${plan.appName}…`);
    if ((await fly(["apps", "create", plan.appName])).code !== 0) {
      return gate(
        `\`fly apps create ${plan.appName}\` failed — Fly app names are globally unique and it may be taken. ` +
          `Set a unique \`app\` in fly.toml and re-run.`,
      );
    }
  }

  // 4. NO volume step: `fly deploy` creates it from [mounts] on a first deploy, and only it can tell the scheduler
  // which machine (guest size + image) must fit on the host the volume is pinned to. Pre-creating one here placed it
  // blind, and a host with disk but no compute failed the deploy with `insufficient resources … with existing volume`.

  // 5.
  const addresses = await readOutput(fly, "fly", ["ips", "list", "-a", plan.appName, "--json"], ingressAddresses);
  if ("gate" in addresses) return gate(addresses.gate);
  // Check-then-act PER FAMILY: an app that already holds one must still be given the other, or the gate between the
  // two allocations below heals into a permanent half-state.
  for (const [family, allocate] of [
    ["v4", ["ips", "allocate-v4", "--shared", "-a", plan.appName]],
    ["v6", ["ips", "allocate-v6", "-a", plan.appName]],
  ] as const) {
    if (addresses.value[family]) {
      log(`public ${family} address exists — skipping allocate`);
      continue;
    }
    log(`allocating a public ${family} address…`);
    if ((await fly([...allocate])).code !== 0) {
      return gate(`\`fly ${allocate.join(" ")}\` failed — see the flyctl output above`);
    }
  }

  // 6. Secrets — staged (no deploy yet; we deploy with fly.toml next). Values over stdin, not argv.
  const keys = Object.keys(plan.secrets);
  if (keys.length > 0) {
    log(`setting ${keys.length} secret(s): ${keys.join(", ")}`);
    const input = `${keys.map((k) => `${k}=${plan.secrets[k]}`).join("\n")}\n`;
    if ((await fly(["secrets", "import", "--stage", "-a", plan.appName], { input })).code !== 0) {
      return gate("`fly secrets import` failed — see the flyctl output above");
    }
  }

  // 7.
  log("deploying (remote build)…");
  const deployArgs = [
    "deploy",
    ".",
    "-a",
    plan.appName,
    "-c",
    plan.flyConfig,
    "--dockerfile",
    plan.dockerfile,
    "--remote-only",
    "--yes",
    "--ha=false",
  ];
  if ((await fly(deployArgs)).code !== 0) {
    return gate("`fly deploy` failed — see the flyctl output above; fix and re-run");
  }

  // 8. `fly deploy` exits 0 on a machine that then crash-loops, so readiness is asked here and not inferred.
  const baseUrl = `https://${plan.appName}.fly.dev`;
  const healthGate = await publicHealthGate({
    baseUrl,
    channels: plan.channels,
    log,
    inspectHint:
      `the app itself deployed — inspect \`fly logs -a ${plan.appName}\`, then re-run once it answers ` +
      `(a re-run repeats the remote build)`,
    probe: healthProbe,
    ...(plan.boxLogin ? { login: plan.boxLogin.command } : {}),
  });
  if (healthGate) return gate(healthGate);
  const notLoggedIn = await plan.boxLogin?.run();
  if (notLoggedIn) {
    return gate(
      loginGate({
        notLoggedIn,
        channels: plan.channels,
        log,
        baseUrl,
        afterLogin: "re-run `fastagent deploy fly --run` (it keeps the login)",
      }),
    );
  }

  // 9.
  const registrationGateMsg = await registerWebhooks({
    baseUrl,
    channels: plan.channels,
    registrars,
    log,
    retryHint: "re-run to retry registration (steps already done are skipped)",
  });
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true };
}
