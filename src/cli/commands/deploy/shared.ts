/**
 * What every host's deploy command shares: the context the dispatcher hands a host, the artifact
 * writer with its ownership rule, and the `--run` credential carry. Host facts live in
 * `cli/commands/deploy/<host>.ts`; this file holds nothing that names one.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import { registerFeishuWebhook } from "../../../channels/feishu/register-webhook.ts";
import { DEPLOY_REGISTRATION_ATTEMPTS } from "../../../channels/registration.ts";
import { readSlackBotAuthEnv } from "../../../channels/slack/bot-auth.ts";
import { registerSlackWebhook } from "../../../channels/slack/register-webhook.ts";
import { registerTelegramWebhook } from "../../../channels/telegram/register-webhook.ts";
import type { Registrars } from "../../../deploy/channel-ingress.ts";
import { isGeneratedDockerfile, isGeneratedDockerignore } from "../../../deploy/container.ts";
import type { DeployPreflight } from "../../../deploy/preflight.ts";
import { assembleSecrets } from "../../../deploy/secrets.ts";
import type { FastagentConfig } from "../../../engines/pi/config.ts";
import { exists, resolveStateRoot } from "../../../paths.ts";
import { failStartup } from "../../fail.ts";

export interface DeployOptions {
  run?: boolean;
  tunnel?: boolean;
  force?: boolean;
  stop?: boolean;
  /** false ⇔ `--no-scale-to-zero`. */
  scaleToZero?: boolean;
  intoLinked?: boolean;
  model?: string;
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

/** What the dispatcher resolved before handing off: the placement, the flags, the config and the
 *  host-neutral pre-flight, plus the channel lists every host asks about. */
interface DeployContext {
  opts: DeployOptions;
  agentDir: string;
  workspace: string;
  config: FastagentConfig;
  pre: Extract<DeployPreflight, { ok: true }>;
  channels: readonly DeclaredChannel[];
  webhookChannels: readonly DeclaredChannel[];
  longConnectionChannels: readonly DeclaredChannel[];
}

/** One deploy target, as the dispatcher sees it. A new host is a `deploy/<host>/` (plan + driver)
 *  plus one of these beside it, and a row in {@link DEPLOY_HOSTS}. */
export interface HostDeploy {
  /** Did this host generate the file at `path`? Only the host's OWN artifacts — the container's
   *  (Dockerfile, .dockerignore) are answered by {@link writeArtifacts} itself. */
  isOurs(path: string, content: string): boolean;
  /** Plan the artifacts from the pre-flight facts and what is on disk, write them, then either drive
   *  the host CLI (`--run`) or print the runbook. Exits through `failStartup` on a gate. */
  deploy(ctx: DeployContext): Promise<void>;
}

/** The registrars every host driver gets. One wiring: a channel's credentials are the channel's, not
 *  the host's, so which of them can run end-to-end never varies by deployment target.
 *
 *  All three get {@link DEPLOY_REGISTRATION_ATTEMPTS} rather than the default: a host CLI returns
 *  before the deployment answers, and a registration that gives up first GATES the deploy — reporting
 *  a working deployment as one to re-run. `dev --tunnel` keeps the shorter default; it is a resident
 *  process whose URL is live when it is printed, as does `deploy docker --run` — it reuses that same
 *  announcer, having already health-probed the container and waited for the Quick Tunnel URL.
 *
 *  Accepted cost: pointChannelsAt registers serially, so a deployment whose channels are ALL
 *  unreachable spends the budget once per channel (3 x 180s) before it gates. Registering in parallel
 *  would not shorten a single failing channel, and the failing case is the one nobody is waiting on. */
export function registrarsFor(agentDir: string): Registrars {
  const attempts = DEPLOY_REGISTRATION_ATTEMPTS;
  return {
    telegram: (baseUrl) => registerTelegramWebhook(baseUrl, { attempts }),
    slack: (baseUrl) => registerSlackWebhook(baseUrl, { stateRoot: resolveStateRoot(agentDir), attempts }),
    feishu: (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind, { attempts }),
  };
}

/**
 * The `--run` credential carry, for every host: the local model credential (an env key, or the whole
 * auth.json as a `FASTAGENT_AUTH_SEED`) plus channel secrets, read through the one environment that
 * accounts for Slack's rotated bot token. Four drivers assembled this identically; a fifth would have
 * had to remember the `deployEnvironment` wrapper, which is invisible when forgotten (a rotated token
 * silently deploys stale).
 */
export async function carryCredentials(params: {
  agentDir: string;
  modelAuth: string | undefined;
  modelKeyInDefinition: boolean;
  authPath: string;
  channels: readonly DeclaredChannel[];
  extraSecrets: string[];
}): Promise<{ secrets: Record<string, string>; missingSecrets: string[]; needsModelCredential: boolean }> {
  const { agentDir, modelAuth, modelKeyInDefinition, authPath, channels, extraSecrets } = params;
  return assembleSecrets({
    modelAuth,
    modelKeyInDefinition,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
    env: deployEnvironment(agentDir, channels),
  });
}

/** Gate a `--run` that has no model credential to carry. Its remediation is `fastagent login`, which
 *  is why it is separate from `missingSecrets` (a `.env` fix) rather than folded into it. Docker states
 *  the same gate inside its driver, where it belongs after the daemon check. */
export function gateOnModelCredential(needsModelCredential: boolean): void {
  if (!needsModelCredential) return;
  failStartup(
    new Error(
      `deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
    ),
  );
}

/**
 * Write each generated artifact under `target`, under ONE ownership rule: **deploy only ever overwrites
 * its own output.** Each generated file opens with a marker, so a file on disk is either OURS (a previous
 * `deploy` wrote it) or the author's — and `--force` means "my generated artifact is authoritative",
 * which never licenses clobbering a file we did not write. To hand a path back to fastagent, delete it.
 *
 * That single rule replaced a second mechanism (a per-host list of paths exempt from `--force`), which
 * only described one shape: with the agent inside the workspace, the root `.dockerignore` is the
 * WORKSPACE's file and was listed; with the agent flat, the list was empty — so `--force` would have
 * overwritten a hand-written root `Dockerfile` in a repository `init --flat` had explicitly adopted.
 * Ownership is a property of the file, not of where the agent sits.
 *
 * A KEPT file of OURS that no longer matches what deploy would generate now (config/channel/lockfile/
 * version drift — or the author's edits, which we cannot tell apart) is flagged stale; `--force`
 * regenerates that one.
 *
 * Exported for its own test — this is a four-branch state machine over (exists, ours, force) that used
 * to be proven by spawning the CLI eight times, which is command LOGIC re-run through a subprocess
 * (see vitest.config.ts) and the suite's slowest test.
 */
export async function writeArtifacts(
  target: string,
  artifacts: { path: string; content: string }[],
  options: { force: boolean; alwaysWrite?: string[]; isOurs: HostDeploy["isOurs"] },
): Promise<void> {
  for (const a of artifacts) {
    const abs = join(target, a.path);
    // Pure build output, not operator-owned configuration. It must track the generated template/runbook.
    if (options.alwaysWrite?.includes(a.path)) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, a.content);
      console.error(`[fastagent] wrote ${a.path}`);
      continue;
    }
    const existing = (await exists(abs)) ? await readFile(abs, "utf8") : undefined;
    const ours = existing !== undefined && isOurArtifact(a.path, existing, options.isOurs);
    if (existing !== undefined && !ours) {
      // Only the `.dockerignore` has content checks in preflight — pointing at "the preflight warnings"
      // for the other kinds would send the reader looking for output that is never printed.
      console.error(
        `[fastagent] kept ${a.path} — not generated by fastagent, so --force does not touch it ` +
          `(delete it to let deploy own the path)` +
          (a.path.endsWith(".dockerignore")
            ? `; see the preflight warnings for what it must exclude`
            : a.path.endsWith("Dockerfile")
              ? `; deploy still assumes it listens on $PORT and runs \`fastagent start /app\``
              : ``),
      );
      continue;
    }
    if (existing !== undefined && !options.force) {
      console.error(
        existing !== a.content
          ? `[fastagent] kept ${a.path} — it no longer matches what deploy would generate (config changed, or ` +
              `you edited it); pass --force to regenerate.`
          : `[fastagent] kept ${a.path} (unchanged)`,
      );
      continue;
    }
    await mkdir(dirname(abs), { recursive: true }); // artifacts live under fastagent/
    await writeFile(abs, a.content);
    console.error(`[fastagent] wrote ${a.path}`);
  }
}

/** Did fastagent generate the file at `path`? The container's two artifacts are every host's; the
 *  rest is the host's own answer. A kind neither names is permanently classified as the author's,
 *  which silently turns `--force` into a no-op for that file. */
function isOurArtifact(path: string, content: string, host: HostDeploy["isOurs"]): boolean {
  if (path.endsWith("Dockerfile")) return isGeneratedDockerfile(content);
  if (path.endsWith(".dockerignore")) return isGeneratedDockerignore(content);
  return host(path, content);
}

function deployEnvironment(agentDir: string, channels: readonly DeclaredChannel[]): NodeJS.ProcessEnv {
  if (!channels.some((channel) => channel.name === "slack")) return process.env;
  const latest = readSlackBotAuthEnv(join(resolveStateRoot(agentDir), "channels", "slack", "bot-auth.json"));
  return { ...process.env, ...latest };
}
