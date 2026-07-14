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
import type { RegistrationOutcome } from "../../channels/registration.ts";
import { registrationGate } from "../registration-gate.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import type { CliRunner } from "../runner.ts";

/**
 * The bytes to seed to the auth file, or undefined to leave it alone — the pure core of `start`'s
 * FASTAGENT_AUTH_SEED materialization. ABSENT-ONLY by design: a present file (a refreshed volume copy)
 * is never overwritten by the stale seed, so a box that ran its own OAuth refresh is not rolled back.
 */
export function authSeedBytes(seed: string | undefined, fileExists: boolean): Buffer | undefined {
  return !seed || fileExists ? undefined : Buffer.from(seed, "base64");
}

export interface FlyRunPlan {
  appName: string;
  region: string;
  /** `KEY=value` secrets to set on Fly: model key (env auth) or `FASTAGENT_AUTH_SEED` (file auth) +
   *  channel secrets. Set via stdin, never argv. */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — the run gates on these before any side effect. */
  missingSecrets: string[];
  channels: ChannelKind[];
  /** fly.toml path passed to `fly deploy -c` (relative to the run cwd = the workspace dir). */
  flyConfig: string;
}

/** Done, or a gate the operator must clear before re-running (printed + non-zero exit by the CLI). */
export type FlyRunOutcome = { ok: true } | { ok: false; gate: string };

/** Whether a `fly … list --json` array contains an object named `name` (Fly capitalizes `Name`; accept both). */
function listHasName(stdout: string, name: string): boolean {
  try {
    const arr = JSON.parse(stdout) as unknown;
    return (
      Array.isArray(arr) &&
      arr.some((o) => (o as { Name?: string; name?: string }).Name === name || (o as { name?: string }).name === name)
    );
  } catch {
    return false;
  }
}

/**
 * Run the deploy through `fly`. `log` reports progress; `registerTelegram(baseUrl)` /
 * `registerFeishu(baseUrl, kind)` perform the post-deploy webhook steps (the CLI passes its canonical
 * Feishu registrar, which also serves the Lark compatibility profile). Absent, the manual console
 * instruction is printed. Every gate is fail-visible.
 */
export async function deployFlyRun(
  plan: FlyRunPlan,
  fly: CliRunner,
  log: (msg: string) => void,
  registerTelegram: (baseUrl: string) => Promise<RegistrationOutcome>,
  registerFeishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>,
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

  // 3. App — idempotent (create only if absent; a taken global name is a gate). A FAILED list is its own
  //    gate: inferring "absent" from an errored query would then misreport the create as a name clash.
  const appsList = await fly(["apps", "list", "--json"], { capture: true });
  if (appsList.code !== 0) return gate("`fly apps list` failed — see the flyctl output above; fix and re-run");
  if (listHasName(appsList.stdout, plan.appName)) {
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
  const volList = await fly(["volumes", "list", "-a", plan.appName, "--json"], { capture: true });
  if (volList.code !== 0) return gate("`fly volumes list` failed — see the flyctl output above; fix and re-run");
  if (listHasName(volList.stdout, "data")) {
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

  // 5. Secrets — staged (no deploy yet; we deploy with fly.toml next). Values over stdin, not argv.
  const keys = Object.keys(plan.secrets);
  if (keys.length > 0) {
    log(`setting ${keys.length} secret(s): ${keys.join(", ")}`);
    const input = `${keys.map((k) => `${k}=${plan.secrets[k]}`).join("\n")}\n`;
    if ((await fly(["secrets", "import", "--stage", "-a", plan.appName], { input })).code !== 0) {
      return gate("`fly secrets import` failed — see the flyctl output above");
    }
  }

  // 6. Deploy — remote builder (no local Docker), one machine.
  log("deploying (remote build)…");
  if (
    (await fly(["deploy", "-a", plan.appName, "-c", plan.flyConfig, "--remote-only", "--yes", "--ha=false"])).code !== 0
  ) {
    return gate("`fly deploy` failed — see the flyctl output above; fix and re-run");
  }

  // 7. Post-deploy webhook — telegram end-to-end (fastagent has the token + the live URL); github is a
  //    repo-settings step only a human can do. Gate policy is the shared registration-gate kernel
  //    (registrars report facts, it owns the policy); all channels are attempted first.
  const reg = registrationGate(log, "re-run to retry registration (steps already done are skipped)");
  if (plan.channels.includes("telegram")) {
    log("registering telegram webhook…");
    reg.track("telegram", await registerTelegram(`https://${plan.appName}.fly.dev`));
  }
  if (plan.channels.includes("github")) {
    log(`github: set the webhook in the repo (Settings → Webhooks) → https://${plan.appName}.fly.dev/webhook`);
  }
  for (const kind of ["feishu", "lark"] as const) {
    if (!plan.channels.includes(kind)) continue;
    if (registerFeishu) {
      log(`registering ${kind} event URL…`);
      reg.track(kind, await registerFeishu(`https://${plan.appName}.fly.dev`, kind));
    } else {
      log(
        `${kind}: set the event Request URL in the developer console (Events & Callbacks) → https://${plan.appName}.fly.dev/${kind} (the app must be running when you save)`,
      );
    }
  }
  const registrationGateMsg = reg.gate();
  if (registrationGateMsg) return gate(registrationGateMsg);
  return { ok: true };
}
