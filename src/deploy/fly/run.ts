/** `fastagent deploy fly --run` — drive flyctl to completion. */
import { type PublicHealthProbe, type Registrars, publicHealthGate, registerWebhooks } from "../channel-ingress.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import type { CliRunner } from "../runner.ts";
import { missingValuesGate } from "../secrets.ts";

export interface FlyRunPlan {
  appName: string;
  region: string;
  /** `KEY=value` secrets to set on Fly: model key (env auth) or `FASTAGENT_AUTH_SEED` (file auth) + channel secrets. */
  secrets: Record<string, string>;
  /** Declared names the value file supplies no value for — the run gates on these before any side effect. */
  missingSecrets: string[];
  /** That value file, workspace-relative, so the gate names the file this deploy actually read. */
  valueFile: string;
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /** fly.toml path passed to `fly deploy -c` (relative to the run cwd = the workspace root). */
  flyConfig: string;
  /**
   * Dockerfile path passed explicitly (`fastagent/Dockerfile`, with the workspace as context — flyctl would otherwise
   * resolve it relative to the config's own directory).
   */
  dockerfile: string;
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

/** Whether a `fly … list --json` array contains an object named `name` (Fly capitalizes `Name`; accept both). */
export function listHasName(stdout: string, name: string): boolean {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  return entries.some(
    (o) => (o as { Name?: string; name?: string }).Name === name || (o as { name?: string }).name === name,
  );
}

/**
 * A read-only `fly … list --json`, reduced to the question the next step asks of it — or the gate for a list we cannot
 * act on.
 */
async function readList<T>(
  fly: CliRunner,
  args: string[],
  read: (stdout: string) => T,
): Promise<{ value: T } | { gate: string }> {
  // The command as RUN, not a restatement of it.
  const cmd = `fly ${args.join(" ")}`;
  const result = await fly(args, { capture: true });
  if (result.code !== 0) return { gate: `\`${cmd}\` failed — see the flyctl output above; fix and re-run` };
  try {
    return { value: read(result.stdout) };
  } catch (error) {
    // The one place a parse failure is allowed to stop being an exception.
    return {
      gate:
        `\`${cmd}\` was unreadable (${error instanceof Error ? error.message : String(error)}) — ` +
        `run it yourself and check the flyctl version; fix and re-run`,
    };
  }
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
  const appExists = await readList(fly, ["apps", "list", "--json"], (out) => listHasName(out, plan.appName));
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

  // 4.
  const volumeExists = await readList(fly, ["volumes", "list", "-a", plan.appName, "--json"], (out) =>
    listHasName(out, "data"),
  );
  if ("gate" in volumeExists) return gate(volumeExists.gate);
  if (volumeExists.value) {
    log(`volume data exists — skipping create`);
  } else {
    log(`creating volume data in ${plan.region}…`);
    if (
      (await fly(["volumes", "create", "data", "-a", plan.appName, "--region", plan.region, "--size", "1", "--yes"]))
        .code !== 0
    ) {
      return gate("`fly volumes create` failed — see the flyctl output above");
    }
  }

  // 5.
  const addresses = await readList(fly, ["ips", "list", "-a", plan.appName, "--json"], ingressAddresses);
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
  });
  if (healthGate) return gate(healthGate);

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
