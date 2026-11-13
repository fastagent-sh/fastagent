/**
 * What every host's deploy command shares: the context the dispatcher hands a host and the artifact writer with its
 * ownership rule.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import { registerFeishuWebhook } from "../../../channels/feishu/register-webhook.ts";
import { DEPLOY_REGISTRATION_ATTEMPTS } from "../../../channels/registration.ts";
import { registerTelegramWebhook } from "../../../channels/telegram/register-webhook.ts";
import type { Registrars, UrlRecorder } from "../../../deploy/channel-ingress.ts";
import { recordChannelUrl } from "../../channel-app.ts";
import { IMAGE_APP_DIR, isGeneratedDockerfile, isGeneratedDockerignore } from "../../../deploy/container.ts";
import type { DeployPreflight } from "../../../deploy/preflight.ts";
import type { DeploymentApi } from "../../../deploy/api.ts";
import type { EffectiveConfig } from "../../../harnesses/pi-durable/config.ts";
import { exists } from "../../../paths.ts";
import { type BoxLoginStep, type BoxShell, deploymentLoginCommand } from "../../../deploy/box-shell.ts";
import { loginOnBox } from "../../box-login.ts";
import type { DeployHost } from "../../../deploy/hosts.ts";

export interface DeployOptions {
  run?: boolean;
  force?: boolean;
  intoLinked?: boolean;
  /** `--idle-timeout <seconds>` (agentcore): how long an idle session keeps its microVM, over the program's default. */
  idleTimeout?: string;
  /** `--config <file>`: the instance configuration the deployment delivers. */
  config?: string;
  /** `--env-file <file>`: the values to give the target. */
  envFile?: string;
  /** `--from-env`: the environment this command runs in is a source of those values too. */
  fromEnv?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--json`: report the deploy outcome as JSON. */
  json?: boolean;
}

/**
 * Who answers interactive steps during deploy: the person at this terminal, or nobody (CI, `--no-input`, `--json`),
 * for whom an unfulfilled interactive step stops the deploy naming what to run.
 */
export type Answerer = { kind: "terminal" } | { kind: "nobody" };

/**
 * What the dispatcher resolved before handing off: the agent directory, the flags, the config and the host-neutral
 * pre-flight, plus the channel lists every host asks about.
 */
interface DeployContext {
  opts: DeployOptions;
  answerer: Answerer;
  /** The command that runs this deploy again, from where it ran: its agent directory and flags. */
  rerun: string;
  agentDir: string;
  /** The instance's name (`deploymentName`): what the host's resources and the generated manifests are called. */
  name: string;
  config: EffectiveConfig;
  pre: Extract<DeployPreflight, { ok: true }>;
  /** Whether the deployment serves the Agent API, so whether the deploy mints its key. */
  api: DeploymentApi;
  channels: readonly DeclaredChannel[];
  webhookChannels: readonly DeclaredChannel[];
  /** Write this host's planned artifacts into the agent directory under the ownership rule. */
  write(
    artifacts: { path: string; content: string }[],
    options: { force: boolean; alwaysWrite?: string[] },
  ): Promise<void>;
}

/** One deploy target, as the dispatcher sees it. */
export interface HostDeploy {
  /** Did this host generate the file at `path`? */
  isOurs(path: string, content: string): boolean;
  /** The manifest an earlier version wrote under a name no instance has, which is no longer read. */
  legacyManifest: { file: string; generated(content: string): boolean; renamed(name: string): string };
  /** The shell into the running box of the instance `name` (`fastagent login --deployment`). */
  shell(agentDir: string, name: string): Promise<BoxShell>;
  validate?(ctx: Pick<DeployContext, "opts" | "agentDir" | "name" | "pre">): void;
  /**
   * Plan the artifacts from the pre-flight facts and what is on disk, write them, then either drive the host CLI
   * (`--run`) or print the runbook. Answers the URL the deployment is reached at, when this host knows it.
   */
  deploy(ctx: DeployContext): Promise<string | undefined>;
}

/**
 * At a terminal, with a `--config` file to write to: record each URL a person sets on a platform's page once the box
 * confirms it, so later deploys of that configuration, CI included, report it `registered` from the start.
 */
export function urlRecorder(
  agentDir: string,
  config: string | undefined,
  values: ReadonlyMap<string, string>,
  answerer: Answerer,
): { recordUrl?: UrlRecorder } {
  if (answerer.kind !== "terminal" || config === undefined) return {};
  const file = resolve(config);
  return {
    recordUrl: {
      waitMs: 10 * 60_000,
      write: async (kind, url) => {
        await recordChannelUrl(agentDir, file, kind, url, values);
        return file;
      },
    },
  };
}

/** The registrars every host driver gets. */
export function registrarsFor(values: ReadonlyMap<string, string>): Registrars {
  const attempts = DEPLOY_REGISTRATION_ATTEMPTS;
  const env = Object.fromEntries(values);
  return {
    telegram: (baseUrl) => registerTelegramWebhook(baseUrl, { attempts, env }),
    feishu: (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind, { attempts, env }),
  };
}

/**
 * The login `--run` starts on the box it just deployed, before any webhook is pointed at it (a host driver's `boxLogin`): for
 * the model's provider, keeping a credential the box already holds (a redeploy), and asking only when a person can
 * answer. None when the model's credential travels as a variable.
 */
export function boxLoginStep<Args extends unknown[]>(
  host: DeployHost,
  params: {
    agentDir: string;
    boxLogin: string | undefined;
    answerer: Answerer;
    config?: string | undefined;
    envFile?: string | undefined;
  },
  /** The shell, from whatever the driver learns only after deploying (AgentCore's runtime ARN). */
  shell: (...args: Args) => BoxShell,
): { boxLogin?: BoxLoginStep<Args> } {
  const provider = params.boxLogin;
  if (provider === undefined) return {};
  const command = deploymentLoginCommand(host, provider, { configFile: params.config, envFile: params.envFile });
  const { answerer } = params;
  return {
    boxLogin: {
      command,
      run: async (...args) =>
        loginOnBox({
          host,
          shell: shell(...args),
          provider,
          ifMissing: true,
          input: answerer.kind === "terminal",
          ...(params.config === undefined ? {} : { configFile: params.config }),
          ...(params.envFile === undefined ? {} : { envFile: params.envFile }),
        }),
    },
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
    if (options.alwaysWrite?.includes(a.path)) {
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
              ? `; deploy still assumes it listens on $PORT and runs \`fastagent start ${IMAGE_APP_DIR}\``
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
      await mkdir(dirname(step.abs), { recursive: true });
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
