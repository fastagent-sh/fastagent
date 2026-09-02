/**
 * `fastagent deploy fly --run` — drive flyctl to completion. The middle of the deploy (app / volume /
 * secrets / deploy) that the plain runbook hands to the operator; `--run` executes it instead, so a
 * coding agent runs ONE command. Idempotent (app/volume check-then-act; channel secrets come from the
 * local env — NOT minted — so a re-run sets the same values) and resumable: it STOPS at a human gate
 * (not logged in, a missing secret value, a taken app name, a failed webhook registration) with one actionable line and a non-zero
 * exit, so the agent clears the gate and re-runs. A `generate` channel secret absent from `.env` is a
 * gate too (`missingSecrets`), not a silent mint — fill it in `.env` (use the random string that
 * `add <channel>` prints).
 *
 * flyctl is behind the shared {@link CliRunner} seam — production spawns `fly`, tests inject a fake that
 * records the command sequence and scripts outputs. That seam is the benchmark: the agent's journey
 * encoded as an asserted command sequence + gate behavior, validated without a real Fly account.
 *
 * Non-interactive incantations the agent would otherwise get wrong: `--remote-only` (build on Fly's
 * builders — no local Docker in a sandbox), `--yes` (no prompts), `--ha=false` + the mounted volume
 * (one machine, the single-machine tier). Secrets go in via `secrets import` over stdin, so values
 * never land in argv/process listings.
 */
import { type Registrars, registerWebhooks } from "../channel-ingress.ts";
import type { DeclaredChannel } from "../../channels/discover.ts";
import type { CliRunner } from "../runner.ts";

export interface FlyRunPlan {
  appName: string;
  region: string;
  /** `KEY=value` secrets to set on Fly: model key (env auth) or `FASTAGENT_AUTH_SEED` (file auth) +
   *  channel secrets. Set via stdin, never argv. */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — the run gates on these before any side effect. */
  missingSecrets: string[];
  /** Every declared channel and its ingress — the driver asks which of them have a webhook. */
  channels: readonly DeclaredChannel[];
  /** fly.toml path passed to `fly deploy -c` (relative to the run cwd = the workspace root). */
  flyConfig: string;
  /** Dockerfile path passed explicitly (`fastagent/Dockerfile`, with the workspace as context —
   *  flyctl would otherwise resolve it relative to the config's own directory). */
  dockerfile: string;
}

/** Done, or a gate the operator must clear before re-running (printed + non-zero exit by the CLI). */
export type FlyRunOutcome = { ok: true } | { ok: false; gate: string };

/** The `Type` values that put an app on `https://<app>.fly.dev`. The rest of flyctl's vocabulary —
 *  `private_v6` (Flycast), `egress_v4`, `egress_v6`, `egress_pair` — is internal or outbound. */
const PUBLIC_IP_TYPES = new Set(["v4", "v6", "shared_v4"]);

/**
 * Whether `fly ips list --json` shows a PUBLIC ingress address. The list is EVERY assignment the app
 * holds, and a Flycast or egress address carries a non-empty `Address` too — reading one as routable
 * reproduces #425 on an app that has one, and pre-empts flyctl's own first-deploy fallback, which
 * returns early once any assignment exists.
 *
 * Output that is not a JSON array THROWS rather than reading as "no address": the caller turns that
 * into a gate, because a list we cannot read is not a state we can act on.
 */
export function hasIngressAddress(stdout: string): boolean {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  return (entries as { Address?: unknown; Type?: unknown }[]).some(
    (entry) => typeof entry?.Address === "string" && entry.Address !== "" && PUBLIC_IP_TYPES.has(entry.Type as string),
  );
}

/**
 * Whether a `fly … list --json` array contains an object named `name` (Fly capitalizes `Name`; accept
 * both). Exported for the same reason railway's parsers are: what it encodes is an assumption about
 * another tool's output, and the live probe checks that assumption against the real `flyctl`.
 *
 * THROWS on output that is not a JSON array, for the same reason {@link hasIngressAddress} does —
 * `false` here means "the host does not have it", and answering that for a list nobody could read
 * creates a SECOND volume, or in teardown destroys nothing at all.
 */
export function listHasName(stdout: string, name: string): boolean {
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error(`expected a JSON array, got ${typeof entries}`);
  return entries.some(
    (o) => (o as { Name?: string; name?: string }).Name === name || (o as { name?: string }).name === name,
  );
}

/**
 * A read-only `fly … list --json`, reduced to the question the next step asks of it — or the gate for
 * a list we cannot act on. THE place the three answers stay three: the command failed, the output was
 * unreadable, or the host gave a verdict. Collapsing the middle one into `false` is what shipped #425
 * and what would have skipped a teardown.
 */
async function readList(
  fly: CliRunner,
  args: string[],
  label: string,
  read: (stdout: string) => boolean,
): Promise<{ value: boolean } | { gate: string }> {
  const result = await fly(args, { capture: true });
  if (result.code !== 0) return { gate: `\`fly ${label}\` failed — see the flyctl output above; fix and re-run` };
  try {
    return { value: read(result.stdout) };
  } catch (error) {
    return {
      gate:
        `\`fly ${label} --json\` was unreadable (${error instanceof Error ? error.message : String(error)}) — ` +
        `run it yourself and check the flyctl version; fix and re-run`,
    };
  }
}

/**
 * Run the deploy through `fly`. `log` reports progress; the injected {@link Registrars} perform the
 * post-deploy webhook steps from the builder machine (Slack's control credential never travels to the
 * host). A registrar the caller did not wire becomes the printed manual step. Every gate is
 * fail-visible.
 */
export async function deployFlyRun(
  plan: FlyRunPlan,
  fly: CliRunner,
  log: (msg: string) => void,
  registrars: Registrars,
): Promise<FlyRunOutcome> {
  const gate = (g: string): FlyRunOutcome => ({ ok: false, gate: g });

  // 1. Auth is the one gate a coding agent can't clear itself (browser OAuth). `whoami` succeeds with
  //    either an interactive login or FLY_API_TOKEN, so one check covers both.
  if ((await fly(["auth", "whoami"], { capture: true })).code !== 0) {
    return gate("not logged in to Fly — run `fly auth login` (opens a browser), or set FLY_API_TOKEN, then re-run");
  }

  // 2. Gate missing required secret VALUES before any side effect (no half-created infra).
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no local value for: ${plan.missingSecrets.join(", ")} — set them in .env (or the environment) and re-run`,
    );
  }

  // 3. App — idempotent (create only if absent; a taken global name is a gate). An unusable list is its
  //    own gate ({@link readList}): inferring "absent" from a query nobody could read would then
  //    misreport the create as a name clash.
  const appExists = await readList(fly, ["apps", "list", "--json"], "apps list", (out) =>
    listHasName(out, plan.appName),
  );
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

  // 4. Volume — idempotent; region comes from fly.toml (must match the machine's region). A failed list
  //    gates for the same reason as the app list above.
  const volumeExists = await readList(fly, ["volumes", "list", "-a", plan.appName, "--json"], "volumes list", (out) =>
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

  // 5. Ingress address — `[http_service]` in fly.toml DECLARES a service; it does not create an address
  //    to reach it on. `fly launch` allocates one as part of its flow, and this driver does not use it,
  //    so without this step the deploy succeeds, the machine serves, and `https://<app>.fly.dev` has no
  //    DNS record at all — reported as a healthy deploy, and handed to the webhook registrars as a URL
  //    they then fail to reach. Check-then-act like the volume above; both allocations are free.
  const addressExists = await readList(fly, ["ips", "list", "-a", plan.appName, "--json"], "ips list", (out) =>
    hasIngressAddress(out),
  );
  if ("gate" in addressExists) return gate(addressExists.gate);
  if (addressExists.value) {
    log("public address exists — skipping allocate");
  } else {
    log("allocating a public address…");
    // v4 SHARED (free, and what every client can reach) plus v6. A dedicated v4 is billed, so it stays
    // an operator decision — `fly ips allocate-v4 -a <app>` after the fact, which this step then skips.
    if ((await fly(["ips", "allocate-v4", "--shared", "-a", plan.appName])).code !== 0) {
      return gate("`fly ips allocate-v4 --shared` failed — see the flyctl output above");
    }
    if ((await fly(["ips", "allocate-v6", "-a", plan.appName])).code !== 0) {
      return gate("`fly ips allocate-v6` failed — see the flyctl output above");
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

  // 7. Deploy — remote builder (no local Docker), one machine. Context + Dockerfile are passed
  //    explicitly (the workspace root is the context; the Dockerfile lives under fastagent/).
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

  // 8. Post-deploy webhook — which channels, in what words, and the gate policy are all the shared
  //    kernel's; Fly contributes its deterministic URL and how to retry.
  const registrationGateMsg = await registerWebhooks({
    baseUrl: `https://${plan.appName}.fly.dev`,
    channels: plan.channels,
    registrars,
    log,
    retryHint: "re-run to retry registration (steps already done are skipped)",
  });
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true };
}
