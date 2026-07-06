/**
 * `fastagent deploy railway --run` — drive the Railway CLI to completion. The middle of the deploy the
 * plain runbook hands to the operator; `--run` executes it so a coding agent runs ONE command.
 *
 * Railway's model forces differences from the Fly runner (fly-run.ts), all validated against CLI 5.15.0:
 *
 *  - **`railway init` is not check-then-act.** It ALWAYS makes a new project (re-running duplicates it),
 *    and `railway status` returns exit 0 even when unlinked — so linkedness is read from stdout: `status
 *    --json` prints JSON only when a project is linked, nothing (message → stderr) when not. Linked →
 *    skip init/add (re-running them DUPLICATES the project/service); unlinked → create them. The volume
 *    is check-then-act EITHER way — linked ≠ fully provisioned (a run that made the service but failed at
 *    volume-add must still get its volume, or it deploys with no persistence: silent state loss).
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
import type { ChannelKind } from "../scaffold/add-channel.ts";

export interface RailwayRunResult {
  code: number;
  /** Captured stdout, for `--json` queries; empty for streamed (inherited) commands. */
  stdout: string;
}

/**
 * The `railway` dispatcher seam. `capture` collects stdout (for `--json` queries); without it the command
 * streams to the terminal (up/deploy) and stdout is empty. `input` is fed to stdin (a secret value).
 */
export type RailwayRunner = (args: string[], opts?: { capture?: boolean; input?: string }) => Promise<RailwayRunResult>;

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
}

/** Done (with the live URL), or a gate the operator must clear before re-running (printed + non-zero
 *  exit by the CLI). */
export type RailwayRunOutcome = { ok: true; url: string } | { ok: false; gate: string };

/** Linked iff `railway status --json` put JSON on stdout. Stdout-PRESENCE is the signal because it is
 *  robust to how the CLI reports unlinked: on 5.15.0 an unlinked dir prints its message to stderr, leaves
 *  stdout empty, AND still exits 0 — so the exit code can't be trusted, but an empty stdout is unambiguous. */
export function parseLinked(stdout: string): boolean {
  const t = stdout.trim();
  if (!t) return false;
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === "object";
  } catch {
    return false;
  }
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
 * Run the deploy through `railway`. `log` reports progress; `registerTelegram(baseUrl)` performs the
 * post-deploy webhook step (the CLI passes its telegram registrar). Every gate is fail-visible.
 */
export async function deployRailwayRun(
  plan: RailwayRunPlan,
  railway: RailwayRunner,
  log: (msg: string) => void,
  registerTelegram: (baseUrl: string) => Promise<void>,
): Promise<RailwayRunOutcome> {
  const gate = (g: string): RailwayRunOutcome => ({ ok: false, gate: g });
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

  // 3. Linked? (stdout-based, see parseLinked). Unlinked → create the project + service; linked → this is
  //    a redeploy, skip creation (re-running init/add would duplicate the project + service, splitting state).
  const status = await railway(["status", "--json"], { capture: true });
  if (parseLinked(status.stdout)) {
    log(`project already linked — redeploying (skipping init/add; volume is checked below)`);
  } else {
    log(`creating project ${plan.name}…`);
    if ((await railway(["init", "--name", plan.name])).code !== 0) {
      return gate(
        "`railway init` failed — if you have multiple workspaces, run it once interactively (or pass --workspace) to pick one, then re-run",
      );
    }
    // Create + link the service (railway init makes only a project). Must precede the volume, which has
    // no --service flag and attaches to the linked service.
    log(`creating service ${plan.name}…`);
    if ((await railway(["add", "--service", plan.name])).code !== 0) {
      return gate("`railway add --service` failed — see the railway output above; fix and re-run");
    }
  }

  // 3b. Volume — check-then-act, ALWAYS (like Fly's per-resource skip-if-present). `parseLinked` means
  //     "project linked", NOT "fully provisioned": if a prior run created the service but failed at volume
  //     add, a re-run is linked yet has no volume — without this check it would deploy with NO persistence
  //     and FASTAGENT_STATE_DIR=/data would be empty every redeploy (silent state loss). So verify + add.
  const vols = await railway(["volume", "list", "--json"], { capture: true });
  if (parseHasVolume(vols.stdout, plan.mountPath)) {
    log(`volume at ${plan.mountPath} exists — skipping`);
  } else {
    log(`creating volume at ${plan.mountPath}…`);
    if ((await railway(["volume", "add", "--mount-path", plan.mountPath])).code !== 0) {
      return gate("`railway volume add` failed — see the railway output above");
    }
  }

  // 4. Variables — set BEFORE deploy so the first boot has them. State root on argv (not secret); secrets
  //    one-per-`set --stdin` (value on stdin, never argv). Idempotent: same values on a re-run.
  log(`setting FASTAGENT_STATE_DIR + ${Object.keys(plan.secrets).length} secret(s)…`);
  if ((await railway(["variables", "set", `FASTAGENT_STATE_DIR=${plan.mountPath}`, ...svc])).code !== 0) {
    return gate("`railway variables set` failed — see the railway output above");
  }
  for (const [k, v] of Object.entries(plan.secrets)) {
    if ((await railway(["variables", "set", k, "--stdin", ...svc], { input: v })).code !== 0) {
      return gate(`\`railway variables set ${k}\` failed — see the railway output above`);
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
  if (plan.channels.includes("telegram")) {
    log("registering telegram webhook…");
    await registerTelegram(url);
  }
  if (plan.channels.includes("github")) {
    log(`github: set the webhook in the repo (Settings → Webhooks) → ${url}/webhook`);
  }
  return { ok: true, url };
}
