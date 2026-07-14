/**
 * `fastagent deploy railway --run` — drive the Railway CLI to completion. The middle of the deploy the
 * plain runbook hands to the operator; `--run` executes it so a coding agent runs ONE command.
 *
 * Railway's model forces differences from the Fly runner (fly/run.ts), all validated against CLI 5.15.0:
 *
 *  - **`--run` PROVISIONS a project and only runs on an UNLINKED directory** — so it can never deploy
 *    into a project it didn't create. `railway init` isn't check-then-act (it ALWAYS makes a new project)
 *    and `railway status` exits 0 even when unlinked (linkedness is read from stdout: JSON when linked,
 *    empty when not). We do NOT track ownership: a pre-existing link is refused (Railway has no globally
 *    unique name to give free identity like Fly's app name, and synthesizing one — a machine-local marker
 *    — was a large, bug-prone premature optimization). The only "yes, this project" signal is the operator's
 *    explicit `--into-linked`, which provisions INTO the linked project; a routine redeploy is just
 *    `railway up`. The volume is check-then-act, so `--into-linked` (or a create that failed at volume-add) still gets it.
 *  - **Every command needs `--service` explicitly** to stay non-interactive (a bare command prompts to
 *    pick a service). `railway volume add` is the exception — it has NO `--service` flag and rides the
 *    linked service, so the service must be created (and thus linked) first.
 *  - **The public URL is minted, not deterministic** — bare `railway domain --json` returns the service
 *    domain (minting one if absent), read for the webhook. We avoid the newer `domain list` subcommand:
 *    on a CLI without it, `railway domain list` registers a bogus custom domain named "list" (destructive).
 *
 * Secrets go in one-per-`variable set --stdin` (value on stdin, never argv/process listing — Railway has
 * no bulk stdin import like Fly's `secrets import`). Auth needs an ACCOUNT credential (login or
 * `RAILWAY_API_KEY`), not a project token: `init` creates a project that a project token can't predate.
 */
import type { RegistrationOutcome } from "../../channels/registration.ts";
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import type { CliRunner } from "../runner.ts";

export interface RailwayRunPlan {
  /** Names both the project (`railway init --name`) and the service (`railway add --service`). Railway
   *  names are project-scoped, not globally unique — the CLI derives it from the dir basename. */
  name: string;
  /** The volume mount path AND `FASTAGENT_STATE_DIR` (kept in lockstep). `/data`, matching the Fly recipe. */
  mountPath: string;
  /** `KEY=value` secrets set one-per-`variable set --stdin`: model key (env auth) or `FASTAGENT_AUTH_SEED`
   *  (file auth) + channel secrets. Never on argv. */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — the run gates on these before any side effect. */
  missingSecrets: string[];
  channels: ChannelKind[];
  /** Opt-in (CLI `--into-linked`) to provision INTO the project this directory is already linked to. Off
   *  by default so `--run` only creates on an unlinked dir and never deploys into a pre-existing (possibly
   *  unrelated/production) project; the flag is the operator's explicit "yes, this project". */
  intoLinked: boolean;
}

/** Done (with the live URL), or a gate the operator must clear before re-running (printed + non-zero
 *  exit by the CLI). */
export type RailwayRunOutcome = { ok: true; url: string } | { ok: false; gate: string };

/**
 * Whether `railway status --json` shows a linked project: non-empty stdout. Unlinked prints its message
 * to stderr and leaves stdout EMPTY (the exit code is 0 either way, so it can't be the signal). ANY
 * non-empty output — parseable or not — counts as linked, so an unreadable shape is refused, never
 * mistaken for unlinked (which would `init` a duplicate). Verified against CLI 5.15.0.
 */
export function isLinked(stdout: string): boolean {
  return stdout.trim() !== "";
}

/** The linked project's name for the gate message, or undefined if it can't be read (still linked —
 *  `railway status --json` puts `name` at the top level on 5.15.0). */
export function linkedName(stdout: string): string | undefined {
  try {
    const v = JSON.parse(stdout) as { name?: unknown };
    if (typeof v.name === "string") return v.name;
  } catch {
    /* non-JSON but non-empty → still linked, just no name to show */
  }
  return undefined;
}

/** Every string leaf of a parsed JSON value — the shape-agnostic scan both readers below share: Railway's
 *  `--json` field names aren't guaranteed, so we match on VALUES, not paths. `stdout` that isn't JSON
 *  (an empty/errored query) yields []. */
function jsonStrings(stdout: string): string[] {
  const walk = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(walk)
        : v && typeof v === "object"
          ? Object.values(v).flatMap(walk)
          : [];
  try {
    return walk(JSON.parse(stdout));
  } catch {
    return [];
  }
}

/**
 * The first Railway-provided domain as an https URL, or undefined if none is present — reads `railway
 * domain --json` without assuming exact field names: any string value carrying a `*.railway.app` host
 * wins (unanchored, so a scheme/port/path around it still yields the bare host). Undefined → the CLI
 * gates (register manually).
 */
export function parseDomainUrl(stdout: string): string | undefined {
  for (const s of jsonStrings(stdout)) {
    const host = s.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.railway\.app/i)?.[0];
    if (host) return `https://${host}`;
  }
  return undefined;
}

/**
 * Whether `railway volume list --json` shows a volume at `mountPath` — shape-agnostic, like
 * {@link parseDomainUrl}. Drives check-then-act so a half-provisioned project (service created, volume
 * add failed) self-heals on re-run instead of silently deploying with no volume.
 */
export function parseHasVolume(stdout: string, mountPath: string): boolean {
  return jsonStrings(stdout).includes(mountPath);
}

/**
 * Run the deploy through `railway`. `log` reports progress; `registerTelegram(baseUrl)` /
 * `registerFeishu(baseUrl, kind)` perform the post-deploy webhook steps (the CLI passes its canonical
 * Feishu registrar, which also serves the Lark compatibility profile). Absent, the manual console
 * instruction is printed. Every gate is fail-visible.
 */
export async function deployRailwayRun(
  plan: RailwayRunPlan,
  railway: CliRunner,
  log: (msg: string) => void,
  registerTelegram: (baseUrl: string) => Promise<RegistrationOutcome>,
  registerFeishu?: (baseUrl: string, kind: "feishu" | "lark") => Promise<RegistrationOutcome>,
): Promise<RailwayRunOutcome> {
  const gate = (g: string): RailwayRunOutcome => ({ ok: false, gate: g });
  // Every --service below targets plan.name — the name this tool gives BOTH the project and the service
  // (`init --name` + `add --service`). On a fresh create they match; on `--into-linked` into a hand-made
  // project whose service is named differently, the FIRST --service command (`variables set`) gates —
  // and it's ordered before the volume (which has no --service), so the mismatch fails visibly with no
  // side effect. (Pre-checking the name means walking status's nested multi-service shape — not worth it.)
  const svc = ["--service", plan.name];

  // 1. Auth needs an ACCOUNT credential (browser login or RAILWAY_API_KEY) — a project token can't
  //    predate the project `init` creates. `whoami` succeeds with either.
  if ((await railway(["whoami"], { capture: true })).code !== 0) {
    return gate(
      "not logged in to Railway — run `railway login`, or set RAILWAY_API_KEY (an account token), then re-run",
    );
  }

  // 2. Gate missing required secret VALUES before any side effect (no half-created infra).
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no local value for: ${plan.missingSecrets.join(", ")} — set them in .env (or the environment) and re-run`,
    );
  }

  // 3. Linked? `--run` provisions a project and only runs on an UNLINKED directory, so it can never deploy
  //    into a project it didn't create. A linked directory is REFUSED (naming the project so the operator
  //    sees what it is) UNLESS they pass --into-linked to provision INTO that project deliberately.
  //    Unlinked → create. No ownership is tracked — a pre-existing link is never assumed ours; the only
  //    "yes, this project" signal is the explicit --into-linked. Any non-empty status counts as linked (an
  //    unreadable shape is refused, not mistaken for unlinked, which would `init` a duplicate).
  const status = await railway(["status", "--json"], { capture: true });
  if (isLinked(status.stdout)) {
    if (!plan.intoLinked) {
      const name = linkedName(status.stdout);
      return gate(
        `this directory is already linked to Railway project ${name ? `"${name}"` : "(name unreadable)"}. ` +
          "`--run` provisions a NEW project and only runs on an unlinked directory — it won't deploy into an " +
          "unrelated one. To redeploy an already-provisioned agent, run `railway up`. To provision the agent " +
          "INTO this project, re-run with --into-linked. To start fresh, `railway unlink` first.",
      );
    }
    log(`provisioning into linked project ${linkedName(status.stdout) ?? plan.name} (--into-linked)`);
  } else {
    // --into-linked means "provision into the project this dir is linked to" — but it isn't linked. Don't
    // swallow the flag silently: the operator expected an existing project; say we're creating a fresh one.
    if (plan.intoLinked) {
      log("warn: --into-linked was passed but this directory isn't linked to any project — creating a fresh one");
    }
    log(`creating project ${plan.name}…`);
    if ((await railway(["init", "--name", plan.name])).code !== 0) {
      return gate(
        "`railway init` failed — if you have multiple workspaces, run it once interactively (or pass --workspace) to pick one, then re-run",
      );
    }
    // Create + link the service (init makes only a project); it precedes the volume, which has no
    // --service flag and rides the linked service.
    log(`creating service ${plan.name}…`);
    if ((await railway(["add", "--service", plan.name])).code !== 0) {
      // Precise recovery, not "fix and re-run": init already created + linked the project, so a plain
      // re-run hits the linked-gate, and --into-linked SKIPS `add` and then fails at the volume (no
      // service to ride). The clean paths are to create the service by hand then --into-linked, or unlink.
      return gate(
        `\`railway add --service\` failed — \`railway init\` already created the project (this directory is now ` +
          `linked) but not the service. Finish with \`railway add --service ${plan.name}\` here, then re-run with ` +
          `--into-linked; or \`railway unlink\` to detach and start fresh.`,
      );
    }
  }

  // 3b. Variables — set BEFORE the volume/deploy. This is deliberately the FIRST `--service` command: on
  //     an --into-linked into a hand-made project whose service name ≠ plan.name, it gates HERE, before the
  //     volume (which has no --service and would otherwise attach to that service) — so the mismatch fails
  //     visibly with NO side effect. State root on argv (not secret); secrets one-per-`set --stdin` (value
  //     on stdin, never argv). Idempotent. (Order vs the volume is free — both just need to precede `up`.)
  log(`setting FASTAGENT_STATE_DIR + ${Object.keys(plan.secrets).length} secret(s)…`);
  if ((await railway(["variables", "set", `FASTAGENT_STATE_DIR=${plan.mountPath}`, ...svc])).code !== 0) {
    return gate("`railway variables set` failed — see the railway output above");
  }
  for (const [k, v] of Object.entries(plan.secrets)) {
    if ((await railway(["variables", "set", k, "--stdin", ...svc], { input: v })).code !== 0) {
      return gate(`\`railway variables set ${k}\` failed — see the railway output above`);
    }
  }

  // 3c. Volume — check-then-act, ALWAYS (like Fly's per-resource skip-if-present). An --into-linked into an
  //     existing project may already have it; a first deploy that failed after this step has it, one that
  //     failed before needs it. Verify + add so we never deploy with NO persistence (FASTAGENT_STATE_DIR
  //     =/data would be empty every redeploy — silent state loss). Runs after variables so a mismatched
  //     service (see above) has already gated — this step won't attach a volume to the wrong service.
  const vols = await railway(["volume", "list", "--json"], { capture: true });
  if (parseHasVolume(vols.stdout, plan.mountPath)) {
    log(`volume at ${plan.mountPath} exists — skipping`);
  } else {
    log(`creating volume at ${plan.mountPath}…`);
    if ((await railway(["volume", "add", "--mount-path", plan.mountPath])).code !== 0) {
      return gate("`railway volume add` failed — see the railway output above");
    }
  }

  // 5. Deploy — CI mode streams build logs then exits (no interactive attach). Build runs on Railway.
  log("deploying (railway up)…");
  if ((await railway(["up", "--ci", ...svc])).code !== 0) {
    return gate("`railway up` failed — see the railway output above; fix and re-run");
  }

  // 6. Public domain — a Railway service isn't reachable until one is minted (unlike Fly's deterministic
  //    <app>.fly.dev), so every deploy needs it (the /invoke + /health surface), not just webhook channels.
  //    The top-level `railway domain` (no subcommand; --json/--service flags are fine) is the long-standing
  //    core command: it returns the service domain, minting one if absent. We do NOT pre-check with the
  //    `domain list` SUBCOMMAND — it's newer, and on a CLI without it `railway domain list` falls through
  //    to the [DOMAIN] positional and registers a bogus custom domain named "list" (destructive). Version-robust.
  log("getting the public domain…");
  const url = parseDomainUrl((await railway(["domain", "--json", ...svc], { capture: true })).stdout);
  if (!url) {
    return gate("couldn't read a domain from `railway domain` — run `railway domain` manually, then set any webhook");
  }
  // 7. Post-deploy webhook — same gate policy as the Fly runner (fly/run.ts step 7): the registrars
  //    report facts, this run owns the policy. "failed" gates (exit 0 would tell a coding agent "done"
  //    while the deployed agent cannot receive messages); "manual" does not gate (re-running can never
  //    change it) but is re-surfaced as the run's LAST line. All channels are attempted first.
  const unregistered: string[] = [];
  const manual: string[] = [];
  const track = (kind: string, outcome: RegistrationOutcome): void => {
    if (outcome === "failed") unregistered.push(kind);
    if (outcome === "manual") manual.push(kind);
  };
  if (plan.channels.includes("telegram")) {
    log("registering telegram webhook…");
    track("telegram", await registerTelegram(url));
  }
  if (plan.channels.includes("github")) {
    log(`github: set the webhook in the repo (Settings → Webhooks) → ${url}/webhook`);
  }
  for (const kind of ["feishu", "lark"] as const) {
    if (!plan.channels.includes(kind)) continue;
    if (registerFeishu) {
      log(`registering ${kind} event URL…`);
      track(kind, await registerFeishu(url, kind));
    } else {
      log(
        `${kind}: set the event Request URL in the developer console (Events & Callbacks) → ${url}/${kind} (the service must be running when you save)`,
      );
    }
  }
  for (const kind of manual) {
    log(`${kind}: webhook registration needs a one-time manual step — see the instructions above`);
  }
  if (unregistered.length > 0) {
    return gate(
      // Composes with cli.ts's "deploy stopped:" prefix — don't say "the deploy succeeded" first.
      `webhook registration failed for: ${unregistered.join(", ")} — the app itself deployed; fix the error above, then re-run with --into-linked to retry registration`,
    );
  }
  return { ok: true, url };
}
