/**
 * What every host's deploy command shares: the context the dispatcher hands a host and the artifact writer with its
 * ownership rule.
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
import type { FastagentConfig } from "../../../engines/pi/config.ts";
import { type ResolvedPlacement, exists, resolveStateRoot } from "../../../paths.ts";
import type { BoxShell } from "../../../deploy/box-shell.ts";
import { loginOnBox } from "../../box-login.ts";
import type { DeployHost } from "../../../deploy/hosts.ts";

export interface DeployOptions {
  run?: boolean;
  tunnel?: boolean;
  force?: boolean;
  intoLinked?: boolean;
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
  /** The file in the agent dir whose presence says this workspace deploys to the host. */
  artifact: string;
  /** The shell into this workspace's running box (`fastagent login --deployment`). */
  shell(placement: ResolvedPlacement): Promise<BoxShell>;
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
 * The login `--run` starts on the box it just deployed, before any entrance opens (a host driver's `boxLogin`): for
 * the model's provider, keeping a credential the box already holds (a redeploy), and asking only when a person can
 * answer. None when the model's credential travels as a variable.
 */
export function boxLoginStep<Args extends unknown[]>(
  host: DeployHost,
  params: ResolvedPlacement & { boxLogin: string | undefined; input: boolean },
  /** The shell, from whatever the driver learns only after deploying (AgentCore's runtime ARN). */
  shell: (...args: Args) => BoxShell,
): { boxLogin?: (...args: Args) => Promise<string | undefined> } {
  const provider = params.boxLogin;
  if (provider === undefined) return {};
  const placement = { agentDir: params.agentDir, workspace: params.workspace };
  return {
    boxLogin: (...args) =>
      loginOnBox({ host, shell: shell(...args), placement, provider, ifMissing: true, input: params.input }),
  };
}

/** One artifact's verdict under the ownership rule: the bytes to write, or `undefined` to keep what is there. */
type ArtifactStep = { abs: string; content: string | undefined; message: string };

/** What `target` would become, and which generated artifacts have drifted from this definition. */
export type ArtifactPlan = { steps: ArtifactStep[]; stale: string[] };

/**
 * Decide what happens to each generated artifact under `target`, under ONE ownership rule — reading only, so a
 * caller can refuse a run BEFORE anything is on disk. `stale` names the paths that would be kept while no longer
 * matching what this definition generates: a fact, not a verdict, because only the caller knows whether this run is
 * about to deploy from one.
 */
export async function planArtifacts(
  target: string,
  artifacts: { path: string; content: string }[],
  options: { force: boolean; alwaysWrite?: string[]; isOurs: HostDeploy["isOurs"] },
): Promise<ArtifactPlan> {
  const plan: ArtifactPlan = { steps: [], stale: [] };
  const write = (path: string, abs: string, content: string) =>
    plan.steps.push({ abs, content, message: `[fastagent] wrote ${path}` });
  const keep = (abs: string, message: string) => plan.steps.push({ abs, content: undefined, message });

  for (const a of artifacts) {
    const abs = join(target, a.path);
    // Pure build output, not operator-owned configuration. It must track the generated template/runbook.
    if (a.path.endsWith(`/${RELEASE_FILE}`) || options.alwaysWrite?.includes(a.path)) {
      write(a.path, abs, a.content);
      continue;
    }
    const existing = (await exists(abs)) ? await readFile(abs, "utf8") : undefined;
    const ours = existing !== undefined && isOurArtifact(a.path, existing, options.isOurs);
    if (existing !== undefined && !ours) {
      // Only the `.dockerignore` has content checks in preflight.
      keep(
        abs,
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
      if (existing !== a.content) plan.stale.push(a.path);
      keep(
        abs,
        existing !== a.content
          ? `[fastagent] kept ${a.path} — it no longer matches what deploy would generate; pass --force to ` +
              `regenerate.`
          : `[fastagent] kept ${a.path} (unchanged)`,
      );
      continue;
    }
    write(a.path, abs, a.content);
  }
  return plan;
}

/** Carry out a {@link planArtifacts} decision. Reports each path, written or kept. */
export async function applyArtifactPlan(plan: ArtifactPlan): Promise<void> {
  for (const step of plan.steps) {
    if (step.content !== undefined) {
      await mkdir(dirname(step.abs), { recursive: true }); // artifacts live under fastagent/
      await writeFile(step.abs, step.content);
    }
    console.error(step.message);
  }
}

/** Did fastagent generate the file at `path`? */
function isOurArtifact(path: string, content: string, host: HostDeploy["isOurs"]): boolean {
  if (path.endsWith("Dockerfile")) return isGeneratedDockerfile(content);
  if (path.endsWith(".dockerignore")) return isGeneratedDockerignore(content);
  return host(path, content);
}
