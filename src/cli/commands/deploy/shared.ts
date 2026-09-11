/**
 * What every host's deploy command shares: the context the dispatcher hands a host, the artifact writer with its
 * ownership rule, and the `--run` credential carry.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import { registerFeishuWebhook } from "../../../channels/feishu/register-webhook.ts";
import { DEPLOY_REGISTRATION_ATTEMPTS } from "../../../channels/registration.ts";
import { registerSlackWebhook } from "../../../channels/slack/register-webhook.ts";
import { registerTelegramWebhook } from "../../../channels/telegram/register-webhook.ts";
import type { Registrars } from "../../../deploy/channel-ingress.ts";
import { isGeneratedDockerfile, isGeneratedDockerignore } from "../../../deploy/container.ts";
import { RELEASE_FILE } from "../../../deploy/workspace.ts";
import type { DeployPreflight } from "../../../deploy/preflight.ts";
import { assembleSecrets } from "../../../deploy/secrets.ts";
import type { FastagentConfig } from "../../../engines/pi/config.ts";
import { exists, resolveStateRoot } from "../../../paths.ts";
import { failStartup } from "../../fail.ts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";

export interface DeployOptions {
  run?: boolean;
  tunnel?: boolean;
  force?: boolean;
  stop?: boolean;
  /** false ⇔ `--no-scale-to-zero`. */
  scaleToZero?: boolean;
  intoLinked?: boolean;
  authPath?: string;
  /** false ⇔ `--no-input`. */
  input?: boolean;
}

/**
 * What the dispatcher resolved before handing off: the placement, the flags, the config and the host-neutral
 * pre-flight, plus the channel lists every host asks about.
 */
interface DeployContext {
  opts: DeployOptions;
  agentDir: string;
  workspace: string;
  config: FastagentConfig;
  pre: Extract<DeployPreflight, { ok: true }>;
  channels: readonly DeclaredChannel[];
  webhookChannels: readonly DeclaredChannel[];
  longConnectionChannels: readonly DeclaredChannel[];
  /** Write this host's planned artifacts into the workspace under the ownership rule. */
  write(
    artifacts: { path: string; content: string }[],
    options: { force: boolean; alwaysWrite?: string[] },
  ): Promise<void>;
}

/** One deploy target, as the dispatcher sees it. */
export interface HostDeploy {
  /** Did this host generate the file at `path`? */
  isOurs(path: string, content: string): boolean;
  /**
   * Plan the artifacts from the pre-flight facts and what is on disk, write them, then either drive the host CLI
   * (`--run`) or print the runbook.
   */
  deploy(ctx: DeployContext): Promise<void>;
}

/** The registrars every host driver gets. */
export function registrarsFor(agentDir: string): Registrars {
  const attempts = DEPLOY_REGISTRATION_ATTEMPTS;
  return {
    telegram: (baseUrl) => registerTelegramWebhook(baseUrl, { attempts }),
    slack: (baseUrl) => registerSlackWebhook(baseUrl, { stateRoot: resolveStateRoot(agentDir), attempts }),
    feishu: (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind, { attempts }),
  };
}

/**
 * The `--run` credential carry, for every host: the local model credential (an env key, or the whole auth.json as a
 * `FASTAGENT_AUTH_SEED`) plus channel secrets.
 */
export async function carryCredentials(params: {
  modelAuth: string | undefined;
  modelKeyInDefinition: boolean;
  authPath: string;
  channels: readonly DeclaredChannel[];
  extraSecrets: readonly DeclaredSecret[];
  /** The deployed environment's declaration, from the pre-flight's single read. */
  values: ReadonlyMap<string, string>;
}): Promise<{ secrets: Record<string, string>; missingSecrets: string[]; needsModelCredential: boolean }> {
  const { modelAuth, modelKeyInDefinition, authPath, channels, extraSecrets, values } = params;
  return assembleSecrets({
    modelAuth,
    modelKeyInDefinition,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
    values,
  });
}

/** Gate a `--run` that has no model credential to carry. */
export function gateOnModelCredential(needsModelCredential: boolean): void {
  if (!needsModelCredential) return;
  failStartup(
    new Error(
      `deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
    ),
  );
}

/** Write each generated artifact under `target`, under ONE ownership rule. */
export async function writeArtifacts(
  target: string,
  artifacts: { path: string; content: string }[],
  options: { force: boolean; alwaysWrite?: string[]; isOurs: HostDeploy["isOurs"] },
): Promise<void> {
  for (const a of artifacts) {
    const abs = join(target, a.path);
    // Pure build output, not operator-owned configuration. It must track the generated template/runbook.
    if (a.path.endsWith(`/${RELEASE_FILE}`) || options.alwaysWrite?.includes(a.path)) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, a.content);
      console.error(`[fastagent] wrote ${a.path}`);
      continue;
    }
    const existing = (await exists(abs)) ? await readFile(abs, "utf8") : undefined;
    const ours = existing !== undefined && isOurArtifact(a.path, existing, options.isOurs);
    if (existing !== undefined && !ours) {
      // Only the `.dockerignore` has content checks in preflight.
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

/** Did fastagent generate the file at `path`? */
function isOurArtifact(path: string, content: string, host: HostDeploy["isOurs"]): boolean {
  if (path.endsWith("Dockerfile")) return isGeneratedDockerfile(content);
  if (path.endsWith(".dockerignore")) return isGeneratedDockerignore(content);
  return host(path, content);
}
