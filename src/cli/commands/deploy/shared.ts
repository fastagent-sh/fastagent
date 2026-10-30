/**
 * What every host's deploy command shares: the context the dispatcher hands a host and the artifact writer with its
 * ownership rule.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DeclaredChannel } from "../../../channels/discover.ts";
import { registerFeishuWebhook } from "../../../channels/feishu/register-webhook.ts";
import { DEPLOY_REGISTRATION_ATTEMPTS } from "../../../channels/registration.ts";
import { registerSlackWebhook } from "../../../channels/slack/register-webhook.ts";
import { registerTelegramWebhook } from "../../../channels/telegram/register-webhook.ts";
import type { Registrars } from "../../../deploy/channel-ingress.ts";
import {
  BUILD_OUTPUTS,
  IMAGE_DEFINITION_DIR,
  isGeneratedDockerfile,
  isGeneratedDockerignore,
} from "../../../deploy/container.ts";
import type { DeployPreflight } from "../../../deploy/preflight.ts";
import type { AgentConfig } from "../../../harnesses/pi-durable/define.ts";
import { exists, resolveStateRoot } from "../../../paths.ts";
import { type BoxLoginStep, type BoxShell, deploymentLoginCommand } from "../../../deploy/box-shell.ts";
import { loginOnBox, ticketLoginIO } from "../../box-login.ts";
import type { TicketStep } from "../../ticket.ts";
import type { DeployHost } from "../../../deploy/hosts.ts";

export interface DeployOptions {
  run?: boolean;
  tunnel?: boolean;
  force?: boolean;
  intoLinked?: boolean;
  /** false ⇔ `--no-input`. */
  input?: boolean;
  /** `--json`: a coding agent's `--run`, run in a ticket that hands each step only a person can take to its user. */
  json?: boolean;
  /** `--check <ticket>`: where such a deploy stands. */
  check?: string;
  /** `--code <code>` (with `--check`): the code a host's approval page showed, when it could not reach this machine. */
  code?: string;
  /** `--stop` (with `--check`): stop that deploy where it is. */
  stop?: boolean;
  /** `--timeout <seconds>`: how long it stays open. */
  timeout?: string;
  /** `--ticket <id>`: the process that runs it. */
  ticket?: string;
}

/**
 * Who takes a deploy's steps only a person can (a host account's sign-in, a production app's confirmation, the box's
 * model login): the person at this terminal, a coding agent's person through the deploy's ticket, or nobody (CI, or a
 * script), for whom such a step stops the deploy naming how to give it.
 */
export type Answerer = { kind: "terminal" } | { kind: "ticket"; step: TicketStep } | { kind: "nobody" };

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
  config: AgentConfig;
  pre: Extract<DeployPreflight, { ok: true }>;
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
  /** The shell into this agent's running box (`fastagent login --deployment`). */
  shell(agentDir: string): Promise<BoxShell>;
  validate?(ctx: Pick<DeployContext, "opts" | "agentDir" | "pre">): void;
  /**
   * Plan the artifacts from the pre-flight facts and what is on disk, write them, then either drive the host CLI
   * (`--run`) or print the runbook. Answers the URL the deployment is reached at, when this host knows it.
   */
  deploy(ctx: DeployContext): Promise<string | undefined>;
}

/** Where a step left to the person goes for `answerer`: a ticket's `afterwards`; nowhere else but the log. */
export function leftToPerson(answerer: Answerer): ((step: string) => void) | undefined {
  return answerer.kind === "ticket" ? (step) => answerer.step.person.afterwards(step) : undefined;
}

/** The registrars every host driver gets; a channel's manual step also goes to `answerer`'s person. */
export function registrarsFor(agentDir: string, values: ReadonlyMap<string, string>, answerer: Answerer): Registrars {
  const attempts = DEPLOY_REGISTRATION_ATTEMPTS;
  const env = Object.fromEntries(values);
  const leave = leftToPerson(answerer);
  return {
    ...(leave === undefined ? {} : { leave }),
    telegram: (baseUrl) => registerTelegramWebhook(baseUrl, { attempts, env }),
    slack: (baseUrl) =>
      registerSlackWebhook(baseUrl, { stateRoot: resolveStateRoot(agentDir), environment: "production", attempts }),
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
  params: { agentDir: string; boxLogin: string | undefined; answerer: Answerer },
  /** The shell, from whatever the driver learns only after deploying (AgentCore's runtime ARN). */
  shell: (...args: Args) => BoxShell,
): { boxLogin?: BoxLoginStep<Args> } {
  const provider = params.boxLogin;
  if (provider === undefined) return {};
  const command = deploymentLoginCommand(host, provider);
  const { answerer } = params;
  return {
    boxLogin: {
      command,
      run: async (...args) => {
        const request = { host, shell: shell(...args), provider, ifMissing: true };
        if (answerer.kind !== "ticket") return loginOnBox({ ...request, input: answerer.kind === "terminal" });
        // An account sign-in: a key cannot be typed into a ticket.
        const io = ticketLoginIO(answerer.step, command);
        const failed = await loginOnBox({ ...request, method: "oauth", input: true, io });
        if (failed !== undefined) return io.refusal() ?? failed;
        // Logged in: what follows (the webhooks) is the deploy finishing, never cut by the person's deadline.
        answerer.step.person.carriesOn();
        return undefined;
      },
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
    if (BUILD_OUTPUTS.includes(basename(a.path)) || options.alwaysWrite?.includes(a.path)) {
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
              ? `; deploy still assumes it listens on $PORT and runs \`fastagent start ${IMAGE_DEFINITION_DIR}\``
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
