/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE the target
 * branch (Docker / Fly / Railway).
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, relative } from "node:path";
import { isModelSpec, isReleaseAgentName } from "./workspace.ts";
import { type FastagentConfig, providerOf, resolveAuthPath } from "../engines/pi/config.ts";
import { AGENT_MODELS_FILE, type ResolvedPlacement, exists } from "../paths.ts";
import { type DeclaredChannel, inspectChannels } from "../channels/discover.ts";
import { loadRoutines } from "../schedule/discover.ts";
import { resolveAgentTools } from "../engines/pi/create.ts";
import { type DeclaredSecret, allSecrets } from "../declared-secrets.ts";
import {
  createPiModelRuntime,
  literalKeyProviders,
  isBuiltinProvider,
  machineModels,
  modelCredentialCarry,
  probeAuthSource,
} from "../engines/pi/models.ts";
import { CHANNEL_KINDS } from "../scaffold/add-channel.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";
import { buildContextPaths, checkKeptIgnoreFiles } from "./build-context.ts";
import { CRON_CAN_BE_EXTERNAL, residencyFor } from "./residency.ts";
import { dotEnvPath, loadEnvValues } from "../env.ts";
import { type DeploymentSecret, deploymentSecrets, isEnvKey } from "./secrets.ts";
import { DEFAULT_HTTP_PORT, describeAnonymousSurface, shouldServeRun } from "../service.ts";
import { CONTROL_PREFIX } from "../channels/control.ts";

/** A stderr line the CLI prints (`[fastagent] warn: …` / `[fastagent] note: …`). */
interface DeployMessage {
  level: "warn" | "note";
  text: string;
}

/** The resolved facts every host plan needs (the container shape, channels, model auth, ports/secrets). */
interface DeployFacts {
  messages: DeployMessage[];
  /** Every declared channel with the ingress its module shape says it has, custom ones included. */
  channels: DeclaredChannel[];
  /**
   * `routines/` declares at least one cron — the one residency reason with an external substitute: `POST /run` lets
   * someone else's clock run a declared routine, so an operator who wants scale-to-zero has an option here.
   */
  hasCron: boolean;
  /**
   * The deployed environment's declaration, read ONCE here so the plan side and the run side cannot disagree about
   * what this deployment carries. The environment running `deploy` is deliberately absent from it (§9).
   */
  values: ReadonlyMap<string, string>;
  /** That file, workspace-relative — the name every "set it here" message must use. */
  valueFile: string;
  /** What satisfies model auth locally — an env-var name, an OAuth/stored label, or undefined. */
  modelAuth: string | undefined;
  /**
   * The definition itself carries the model key (a models.json literal `apiKey`, or a `!command` run on the host), so
   * there is nothing for `--run` to carry AND nothing to gate: `fastagent login` cannot serve a custom provider, so
   * gating on it would strand a correctly configured agent.
   */
  modelKeyInDefinition: boolean;
  /** Every tool/routine/channel declaration — the names the value file must supply, by declaring file. */
  declaredSecrets: DeclaredSecret[];
  /** The runbook's variable list: the declared names, then everything else the value file carries. */
  secrets: DeploymentSecret[];
  /** The project-level auth file `--run` reads to carry the credential (probed with the same path). */
  authPath: string;
  /** Container facts shared by the plan and the generated Dockerfile — ONE source, so they can't drift. */
  container: ContainerInput;
  port: number;
}

/** Done (facts for the host branch), or a hard gate the CLI stops on (a model that won't reach the box). */
export type DeployPreflight = { ok: false; gate: string } | ({ ok: true } & DeployFacts);

/**
 * Where a check says what it found. An ISSUE is what would crash-loop the deployed box: under `--run` the first one
 * stops the pre-flight as its gate, generate-only prints it as a warning and goes on.
 */
export interface DeployReport {
  note(text: string): void;
  warn(text: string): void;
  issue(text: string): void;
}

/** The pre-flight's one early exit: thrown by a check, turned into `{ ok: false, gate }` by {@link preflightDeploy}. */
class DeployGate {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

interface PreflightInput {
  placement: ResolvedPlacement;
  config: FastagentConfig;
  /** `--run` fully deploys, so a definition that resolves NO model is a GATE (a known crash-loop); else it warns. */
  run: boolean;
  /** `--force` regenerates the artifacts fastagent OWNS, so a kept `.dockerignore`'s content checks do not apply. */
  force: boolean;
  /** The target delivers cron slots from an external clock and holds no resident process (AgentCore). */
  externalClock?: boolean;
  /**
   * Does this target publish the serve at a URL anyone can dial? True for every host that mints one (Fly, Railway,
   * a Docker box); false for AgentCore, where the container is reachable only through the Runtime's IAM and the
   * forwarder's shared secret. Kept apart from {@link externalClock} on purpose — they happen to agree on AgentCore
   * today, and answering two questions with one boolean is how the answer to one of them goes wrong later.
   */
  publicUrl?: boolean;
}

/** Run the host-neutral pre-flight. */
export async function preflightDeploy(input: PreflightInput): Promise<DeployPreflight> {
  const messages: DeployMessage[] = [];
  const report: DeployReport = {
    note: (text) => void messages.push({ level: "note", text }),
    warn: (text) => void messages.push({ level: "warn", text }),
    issue: (text) => {
      if (input.run) throw new DeployGate(text);
      messages.push({ level: "warn", text });
    },
  };
  try {
    return { ok: true, messages, ...(await gatherFacts(input, report)) };
  } catch (error) {
    if (error instanceof DeployGate) return { ok: false, gate: error.text };
    throw error;
  }
}

async function gatherFacts(input: PreflightInput, report: DeployReport): Promise<Omit<DeployFacts, "messages">> {
  const {
    placement: { agentDir, workspace },
    config,
    force,
    externalClock,
    publicUrl = true,
  } = input;
  // The release manifest carries this name into the container, where it is joined onto the storage root — so `init`'s
  // "one path segment" is not enough here.
  if (!isReleaseAgentName(basename(agentDir))) {
    throw new DeployGate(
      `the agent directory "${basename(agentDir)}" cannot be deployed — a deployed agent directory ` +
        `may use only letters, digits, "-" and "_"; rename it (the fastagent.config.ts inside is what ` +
        `makes it an agent, never its name)`,
    );
  }
  const agentPrefix = `${basename(agentDir)}/`;

  // The model this deployment will run on, and where it came from. Resolved HERE so the plan side and the run side
  // cannot disagree about it.
  const valueFile = relative(workspace, dotEnvPath(agentDir));
  const values = loadEnvValues(dotEnvPath(agentDir));
  const model = resolveDeployModel(config, values, valueFile);
  if (model.invalid !== undefined) {
    // A gate rather than a warning even without `--run`: the release manifest validates the spec on the way out, so
    // there is no artifact to produce either. Same class as the agent-directory-name gate above.
    throw new DeployGate(
      `the model in ${model.source} is not a "provider/modelId" spec: ${JSON.stringify(model.invalid)}`,
    );
  }
  if (!model.spec) {
    const issue =
      `no model resolves for this deployment — set \`model: "provider/id"\` in fastagent.config.ts (it travels ` +
      `in the image), or FASTAGENT_MODEL in ${valueFile} (deploy records that one in the release manifest)` +
      // Whoever has the variable set right here sees `fastagent info` report a model, so "no model resolves" reads
      // like a bug until the message says which environment was read. It states that fact WITHOUT attributing the
      // value: it may be the operator's shell, or the first-run picker's own pick a second earlier (which prints
      // its own "set `model:` in your config" hint), and the two remedies are the two sources named above.
      (process.env.FASTAGENT_MODEL
        ? `. Note that a FASTAGENT_MODEL in the environment running deploy is not one of those sources — it ` +
          `belongs to this machine, not to the deployment`
        : ``);
    report.issue(issue);
  } else {
    report.note(`model ${model.spec} (source: ${model.source})`);
  }
  const modelSpec = model.spec;

  // Time triggers (static routines or self-scheduling) need a machine kept running, and a declared schedule also
  // decides whether `POST /run` mounts — so the load happens HERE, before the warning that has to name it.
  // Loaded, not just listed: the same load answers "are there time triggers" AND "what did they declare they need".
  // A file that FAILED to load still counts as a trigger — the author will fix it, and a plan that scaled to zero
  // because a cron was broken on deploy day would sleep through it afterwards.
  const loadedRoutines = await loadRoutines(agentDir);

  // What the PUBLIC host URL answers with no authentication of ours, NAMED FROM WHAT WILL ACTUALLY MOUNT (through the
  // same `shouldServeRun` the assembly uses), never from the host alone: listing an endpoint this deployment does not
  // serve is how an operator learns to skim past every deploy warning — the same reason `publicUrl` exists.
  const unauthenticated = describeAnonymousSurface({
    invoke: config.http?.invoke !== false,
    run: loadedRoutines.routines.length > 0 && shouldServeRun(config.http),
    ...(config.sessionControl === true ? { controlPrefix: CONTROL_PREFIX } : {}),
  });
  if (publicUrl && unauthenticated.length > 0) {
    report.warn(
      `the deployed box answers ${unauthenticated.join(" and ")} at its public URL, UNAUTHENTICATED — ` +
        `fastagent authenticates nothing. Put a gateway, an IdP-backed proxy or a private network in front of that ` +
        `URL (docs/design/session-control.md §14)`,
    );
  }

  // Known channel kinds only — a custom channel's webhook (and, unless it declared them, its secrets) are unknown to
  // us; note and let the author wire them.
  const inspected = await inspectChannels(agentDir);
  if (inspected.failures.length > 0) {
    throw new Error(
      `cannot inspect channel modules: ${inspected.failures.map((failure) => `${failure.label}: ${failure.message}`).join("; ")}`,
    );
  }
  const channels = inspected.channels;
  for (const { name, ingress } of channels) {
    if ((CHANNEL_KINDS as string[]).includes(name)) continue;
    const secretsPart = `its variables travel from ${valueFile} like every other`;
    report.note(
      ingress === "long-connection"
        ? `long-connection channel "${name}" is custom — ${secretsPart}; generated deploy plans keep the process running and skip webhook registration`
        : `route channel "${name}" is custom — ${secretsPart}; configure its webhook yourself`,
    );
  }
  const longConnectionChannels = channels.filter((c) => c.ingress === "long-connection").map((c) => c.name);

  // A ROUTINE IS NOT A CRON. `cron` is a field, so counting routine FILES answered a different question: a
  // definition whose only routine is reached by name (`POST /run`) would pin one machine up forever and print a
  // note about a cron instant it does not have. `deploy agentcore` already filtered the same way when it turned
  // routines into EventBridge rules; this is the other reader of that fact, and they must agree.
  //
  // A FAILED file still counts, on the conservative side: it may well declare a cron, and a plan that scaled to
  // zero because the file did not parse would hide that behind silence.
  const hasCron = loadedRoutines.routines.some((r) => r.cron !== undefined) || loadedRoutines.failures.length > 0;
  if (longConnectionChannels.length > 0 && !externalClock) {
    report.note(
      `long-connection channel present (${longConnectionChannels.join(", ")}) — a GENERATED plan keeps one machine running ` +
        `(an outbound connection cannot wake a scaled-to-zero service).`,
    );
  }
  // A cron has an external substitute, and an operator who is paying for an idle box should be told so — unless a
  // long connection pins the box anyway, which residency.ts decides.
  if (hasCron && !externalClock) {
    const wayOut = residencyFor({ channels, hasCron })?.reason === CRON_CAN_BE_EXTERNAL;
    report.note(
      `routines/ present — a GENERATED plan keeps one machine running (nothing wakes this box at a cron ` +
        `instant).` +
        (wayOut
          ? ` To scale to zero instead, keep the time in a scheduler you own and let it call ` +
            `\`POST /run\` (an API that runs one declared unit of work by name — docs/api-reference.md#post-run).`
          : ""),
    );
  }

  await checkMachineModels(agentDir, modelSpec, report);

  // Probe auth from the SAME project-level file the opener/login use, on the registry the DEPLOYED agent has: the
  // machine's models.json does not ship, so an entry there (a gateway over a built-in provider, a key) must not decide
  // how the credential reaches the host.
  const authPath = resolveAuthPath(agentDir);
  const models = await createPiModelRuntime({ agentDir, authPath, machineLayer: false });
  let modelAuth = modelSpec ? await probeAuthSource(models, modelSpec) : undefined;
  let modelKeyInDefinition = false;
  // probeAuthSource answers "is it authenticated here", which is not the deploy question ("how does the credential
  // REACH the host").
  if (modelSpec && !isEnvKey(modelAuth)) {
    const carry = modelCredentialCarry(models, modelSpec);
    if (carry.envVar) modelAuth = carry.envVar;
    else modelKeyInDefinition = carry.inDefinition;
  }

  // Reported, not refused. Whether a string is a credential is the AUTHOR's knowledge: pi's docs prescribe
  // `"apiKey": "ollama"` for a keyless local server, and no static rule separates that from a leaked key. The
  // `.dockerignore` check next to this one IS a gate because it catches a packing rule putting FastAgent's OWN
  // `.secrets/auth.json` into the image — the framework's doing. This is the author's own committed file.
  // Asked of EVERY provider, not just the selected model's: the file ships whole.
  const literalKeys = await literalKeyProviders(agentDir);
  if (literalKeys.length > 0) {
    report.warn(
      `${AGENT_MODELS_FILE} carries a literal apiKey for ${literalKeys.map((id) => `"${id}"`).join(", ")} — that ` +
        `file ships inside the image, where anyone who can pull it reads the layer. If it is a credential, use ` +
        `"$YOUR_ENV_VAR" (deploy carries it like any provider key) or "!command" (it runs on the box and never ` +
        `travels); a placeholder for a keyless local server is fine as it is.`,
    );
  }

  // Container facts (shared by every host) + the warnings that follow.
  const hasPackageJson = await exists(join(agentDir, "package.json"));
  const pkg = await readPackageJson(agentDir);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(agentDir, pkg);
  const install = runtime === "bun" ? "bun install" : "npm install";
  const runner = runtime === "bun" ? "bun run fastagent" : "./node_modules/.bin/fastagent";
  const hasOtherLock =
    runtime === "node" &&
    ((await exists(join(agentDir, "pnpm-lock.yaml"))) || (await exists(join(agentDir, "yarn.lock"))));
  // Does the baked workspace ship a `.git`?
  const shipsGit = await exists(join(workspace, ".git"));
  // After the facts: the deps sentence must match the agent's actual shape (a markdown-only agent has no package.json
  // and installs nothing — the note must not point at a file that doesn't exist).
  const deps = hasPackageJson
    ? `only the agent's deps (${agentPrefix}package.json) are installed — the workspace's own deps are the agent's runtime concern`
    : `the agent has no package.json, so no deps are installed (the pinned global CLI serves the directory)`;
  // What a RELEASE does — host-neutral, because how long the storage under it lives is the host's own answer and its
  // runbook gives it (a Fly volume outlives every deploy; AgentCore's mount does not).
  report.note(
    `the whole directory is baked as the agent's workspace (WYSIWYG — what you see is what ships, ` +
      `git or not, clean or not); ${deps}. The image seeds the storage once; a later release replaces ` +
      `only ${agentPrefix} and leaves the rest of the workspace, state and credentials in place — for ` +
      `how long, see this host's storage note below`,
  );
  // A code agent with no lockfile builds via a non-frozen install (ranges resolve at build time) — not reproducible.
  if (hasPackageJson && !hasLockfile) {
    const lock = runtime === "bun" ? "bun.lock" : "package-lock.json";
    report.warn(
      hasOtherLock
        ? `the generated Dockerfile is npm-based — your pnpm/yarn lockfile is NOT used (build runs ` +
            `\`npm install\`, not reproducible). Edit the Dockerfile for your package manager, or vendor a package-lock.json.`
        : `no ${lock} — the image build resolves deps at build time (not reproducible). ` +
            `Run \`${install}\` and commit the lockfile for pinned redeploys.`,
    );
  }
  // The code-path Dockerfile runs `${runner}`.
  if (hasPackageJson && !("@fastagent-sh/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies })) {
    report.warn(
      `package.json does not list @fastagent-sh/fastagent — the image's \`${runner}\` has no local bin to run, ` +
        `so the container fails at start. Add it to dependencies and re-run \`${install}\`.`,
    );
  }
  const paths = await buildContextPaths(workspace, agentDir, agentPrefix, authPath);
  await checkKeptIgnoreFiles({ workspace, agentDir, agentPrefix, force, paths }, report);

  // Write-back mechanics are fastagent's (the policy is the persona's).
  const apt = shipsGit ? [...new Set(["git", ...(config.deploy?.apt ?? [])])] : config.deploy?.apt;
  const container: ContainerInput = {
    releaseId: randomUUID(),
    agentPrefix,
    machineryPaths: paths.machineryPaths,
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt,
    ...(model.envValue !== undefined ? { modelSpec: model.envValue } : {}),
    shipsGit,
  };
  const port = config.http?.port ?? DEFAULT_HTTP_PORT;
  // EVERYTHING the definition declared it needs, from wherever it was declared. Read through the SAME resolver
  // dev/start mount with, so "which tool declarations count" has one answer (config.tools declare too; a shadowed
  // file's declaration is dropped in both places).
  const resolvedTools = await resolveAgentTools(config, agentDir, workspace);
  // A code input we could not READ is a code input whose declarations we cannot carry — and the box
  // WILL read it (its deps are installed there), so its gate fires after the deploy reported success:
  // a crash loop, which is the failure mode this whole mechanism exists to move to build time. Under
  // `--run` that is a gate, like a channel that fails to inspect; generate-only warns, since the
  // operator may be producing artifacts from a machine that never installed the agent's deps.
  for (const failure of [...resolvedTools.toolFailures, ...loadedRoutines.failures]) {
    const issue =
      `${failure.label} failed to load (${failure.message}) — any secrets it declares cannot be carried ` +
      `to the host, so the deployed box would refuse to start`;
    report.issue(issue);
  }
  const declaredSecrets: DeclaredSecret[] = [
    ...allSecrets(resolvedTools.toolSecrets),
    ...allSecrets(loadedRoutines.secrets),
    ...allSecrets(inspected.secrets),
  ];
  await checkKeptDockerfile(agentDir, config, model.envValue, valueFile, report);

  return {
    channels,
    hasCron,
    values,
    valueFile,
    modelAuth,
    modelKeyInDefinition,
    authPath,
    container,
    port,
    declaredSecrets,
    secrets: deploymentSecrets(modelAuth, declaredSecrets, values, valueFile),
  };
}

/**
 * The machine's models.json is this box's environment, not the artifact: whatever the model takes from it is
 * absent wherever the agent is deployed. Said in so many words here; the credential probe already reads the deployed
 * registry.
 */
async function checkMachineModels(
  agentDir: string,
  modelSpec: string | undefined,
  report: DeployReport,
): Promise<void> {
  const machine = await machineModels(agentDir);
  const provider = modelSpec ? providerOf(modelSpec) : undefined;
  if (provider === undefined || !machine?.inherited.includes(provider)) return;
  if (isBuiltinProvider(provider)) {
    report.warn(
      `model "${modelSpec}" takes its "${provider}" entry from ${machine.path}, the machine's models.json, which ` +
        `does not ship — the deployed agent runs pi's built-in "${provider}" without it. Declare the entry in the ` +
        `agent's own ${AGENT_MODELS_FILE} to deploy it.`,
    );
  } else {
    // No built-in to fall back on: the deployed agent cannot resolve the model at all.
    const issue =
      `model "${modelSpec}" exists only in ${machine.path}, the machine's models.json, which does not ship — the ` +
      `deployed agent would fail with an unknown model. Declare "${provider}" in the agent's own ` +
      `${AGENT_MODELS_FILE} to deploy it.`;
    report.issue(issue);
  }
}

/**
 * What a KEPT hand-written Dockerfile drops. `deploy.apt` is the obvious one; the resolved model is the one that
 * looks safe and is not: the manifest is always written, but only the generated Dockerfile sets
 * FASTAGENT_RELEASE_FILE, and without it `prepareStartWorkspace` never reads the manifest — so a model that lives
 * ONLY in the value file would be reported here and absent on the box.
 *
 * NOT conditioned on `!force`: `writeArtifacts` refuses a file it did not generate whatever the flag says, so a
 * hand-written Dockerfile survives `--force` and drops exactly the same things. Short-circuiting here let
 * `--run --force` ship the crash-loop this gate exists to stop.
 */
async function checkKeptDockerfile(
  agentDir: string,
  config: FastagentConfig,
  /** The model the release manifest carries (set only when the value file named it). */
  modelFromValueFile: string | undefined,
  valueFile: string,
  report: DeployReport,
): Promise<void> {
  const dockerfileHome = join(agentDir, "Dockerfile");
  const dockerfileText = (await exists(dockerfileHome)) ? await readFile(dockerfileHome, "utf8") : undefined;
  if (dockerfileText === undefined || isGeneratedDockerfile(dockerfileText)) return;
  if (config.deploy?.apt?.length) {
    report.warn(
      `kept your hand-written Dockerfile — deploy.apt (${config.deploy.apt.join(", ")}) is ` +
        `NOT applied; install those packages in your Dockerfile.`,
    );
  }
  // The INSTRUCTION is the question, not the file's authorship: `prepareStartWorkspace` returns early without
  // FASTAGENT_RELEASE_FILE, so a Dockerfile that sets it reads the manifest whoever wrote it. This gates rather
  // than warns because it is about FastAgent's OWN delivery arriving — the model would be reported here and
  // missing on the box.
  // Anywhere in an `ENV` instruction, not just first: `ENV A=1 FASTAGENT_RELEASE_FILE=/app/x` is ordinary
  // Dockerfile style and hard-refusing it would be a false gate. A backslash continuation still reads as absent
  // (covering it means joining lines first) — the remaining over-strict edge.
  if (modelFromValueFile !== undefined && !/^\s*ENV\s[^\n]*\bFASTAGENT_RELEASE_FILE[=\s]/m.test(dockerfileText)) {
    const issue =
      `your Dockerfile does not set FASTAGENT_RELEASE_FILE, and the model comes from ${valueFile} — it travels ` +
      `in the release manifest, which is only read when that ENV points at it. Add it (see a generated ` +
      `Dockerfile), or set \`model\` in fastagent.config.ts so it ships in the config instead.`;
    report.issue(issue);
  }
}

/**
 * WHICH model this deployment runs on, and where that came from.
 *
 * There is ONE precedence chain — `flag > environment > config.model` — and this is it evaluated in the environment
 * BEING DEPLOYED rather than in this machine's. That environment is declared by the value file, so the operator's
 * `process.env` simply is not part of it (the same way `dev` never reads another machine's shell); it needs no rule
 * of its own. `deploy` has no flag layer either, and that follows from the same model rather than from policy: a
 * generated Dockerfile is rewritten on every deploy, so a flag baked into one would silently vanish on the next run
 * that omits it. A file does not.
 *
 * The value file is the half of the deployed environment we can DECLARE. The other half — variables the platform
 * already holds — is still on the box and still outranks the image's own `ENV`, which is exactly why the model is
 * baked rather than delivered as one more platform variable that nothing would ever clear.
 */
function resolveDeployModel(
  config: FastagentConfig,
  values: ReadonlyMap<string, string>,
  /** The value file AS READ (it follows `FASTAGENT_SECRETS_DIR`), so the reported source is the real one. */
  valueFile: string,
): { spec?: string; source: string; envValue?: string; invalid?: string } {
  const fromEnv = values.get("FASTAGENT_MODEL");
  const source = fromEnv ? valueFile : "fastagent.config";
  // BOTH sources are checked, at the one point that reads them: a `provider`-less spec resolves to nothing on the
  // box, so letting `config.model` through would ship exactly the crash-loop this resolution exists to prevent —
  // `probeAuthSource` reports "unconfigured" for it here and the failure only appears after deployment.
  const spec = fromEnv || config.model;
  if (spec && !isModelSpec(spec)) return { source, invalid: spec };
  // `envValue` is what the release manifest records (ContainerInput.modelSpec), so it is set only when the value file
  // is the source: a `config.model` already travels in the config itself. The manifest is rewritten by every deploy,
  // so deleting the line and redeploying simply drops it — nothing stale survives.
  if (fromEnv) return { spec: fromEnv, source, envValue: fromEnv };
  return { spec: config.model, source };
}
