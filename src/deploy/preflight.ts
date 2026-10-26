/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE the target
 * branch (Docker / Fly / Railway).
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, relative } from "node:path";
import { isModelSpec, isReleaseAgentName } from "./workspace.ts";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { resolveAuthPath } from "../harnesses/models/credentials.ts";
import {
  environmentAuth,
  interactiveLoginKind,
  loginProviders,
  modelsOver,
  providerOf,
} from "../harnesses/models/models.ts";
import type { AgentConfig } from "../harnesses/pi-durable/define.ts";
import {
  type AgentDefinition,
  type BuiltDefinition,
  buildDefinitionShape,
  definitionSecrets,
  prepareDefinition,
} from "../harnesses/pi-durable/open.ts";
import { LOCAL_CONTEXT_FILE, exists } from "../paths.ts";
import { type DeclaredChannel, channelIngress } from "../channels/discover.ts";
import type { ContentDeclaration } from "../content/declare.ts";
import { loadContent, loadEnvironment } from "../content/file.ts";
import type { DeclaredSecret } from "../declared-secrets.ts";
import { CHANNEL_KINDS } from "../scaffold/add-channel.ts";
import { RUNTIME_FLOOR, belowFloor, detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";
import { buildContextPaths, checkKeptIgnoreFiles } from "./build-context.ts";
import { dotEnvPath, loadEnvValues } from "../env.ts";
import { type DeploymentSecret, deploymentSecrets, isEnvKey } from "./secrets.ts";
import { DEFAULT_HTTP_PORT } from "../service.ts";
import { declaredVariables, declaresTool, runtimeAdvice } from "../environment/declare.ts";
import { checkPackages, MISE_PACKAGE_NAMES, miseBinary, packageSpecs } from "../environment/mise.ts";

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
  /** `src/schedules/` declares at least one schedule. */
  hasCron: boolean;
  /**
   * The deployed environment's declaration, read ONCE here so the plan side and the run side cannot disagree about
   * what this deployment carries. The environment running `deploy` is deliberately absent from it (§9).
   */
  values: ReadonlyMap<string, string>;
  /** That file, agent-dir-relative — the name every "set it here" message must use. */
  valueFile: string;
  /**
   * The variable the value file carries the model's key in, or undefined when no key travels that way
   * ({@link credentialRoute}).
   */
  modelAuth: string | undefined;
  /**
   * The provider the deployment must log in to itself (`fastagent login --deployment`): the model's credential does
   * not travel, because it is neither a variable in the value file nor resolved by the definition's own provider code.
   * Nothing from this machine's credentials file is ever copied, so a login on the box is its only holder.
   */
  boxLogin: string | undefined;
  /** Every declaration the definition makes — the names the value file must supply, by declaring file. */
  declaredSecrets: DeclaredSecret[];
  /** The runbook's variable list: the declared names, then everything else the value file carries. */
  secrets: DeploymentSecret[];
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

/**
 * What each content entry becomes on the host, one line each, so none is missing there unsaid (agent-model.md §3). A
 * repository `context.json` declares is cloned there, as on this machine without a checkout bound. A directory only
 * this machine binds stays here: the deployed agent works without it, which the line says and says how to change. One
 * the agent works on is a warning, since the deployed agent lacks data it was meant to work on; one it only knows, a
 * note.
 */
function checkContent({ declared, bound }: ContentDeclaration, storageResets: boolean, report: DeployReport): void {
  for (const entry of declared) {
    const fate = storageResets
      ? "cloned afresh on every deployment, since the host's storage starts over; what the agent did not push is lost"
      : "cloned on the host, and brought up to date in place at each start";
    report.note(`${roleOf(entry)} ${entry.name}: github ${entry.repo}${entry.ref ? `@${entry.ref}` : ""}, ${fate}`);
  }
  for (const binding of bound) {
    if (binding.kind !== "local") continue;
    const stays =
      `${roleOf(binding)} ${binding.name}: a directory of this machine (${binding.path}, bound in ` +
      `${LOCAL_CONTEXT_FILE}), stays here, and the deployed agent works without it`;
    if (binding.readonly) {
      report.note(
        `${stays}; to ship what the agent reads there, copy it into the agent directory, which every release carries`,
      );
    } else {
      report.warn(
        `${stays}; to work on it from a host, move it to a GitHub repository and add it as github:owner/repo`,
      );
    }
  }
}

function roleOf(entry: { readonly: boolean }): string {
  return entry.readonly ? "knows" : "works on";
}

/**
 * What the image needs to install the packages the agent declares: the agent's own mise for linux in its package.json,
 * so the image's install brings it, packages FastAgent installs from, and a PyPI package's runtime. A machine without
 * the agent's mise cannot check them, which is an issue (a warning without `--run`), as a code input that cannot load
 * is.
 */
async function checkEnvironment(
  agentDir: string,
  packages: Record<string, string>,
  hasPackageJson: boolean,
  pkg: { optionalDependencies?: Record<string, unknown> },
  report: DeployReport,
): Promise<void> {
  if (Object.keys(packages).length === 0) return;
  const linux = MISE_PACKAGE_NAMES.filter((name) => name.includes("-linux-"));
  const missing = linux.filter((name) => !(name in (pkg.optionalDependencies ?? {})));
  if (!hasPackageJson || missing.length > 0) {
    report.issue(
      `context.json declares packages, and the image would have no mise to install them with: the agent's ` +
        `package.json does not list ${missing.join(", ")}. Run \`fastagent env install\` in the agent directory.`,
    );
    return;
  }
  const bin = miseBinary(agentDir);
  if (!bin) {
    report.issue(
      `the agent's mise is not installed here, so the packages context.json declares cannot be checked. Run ` +
        `\`fastagent env install\` in ${agentDir}, then deploy again.`,
    );
    return;
  }
  const { refusals, runtime } = await checkPackages(agentDir, bin, packages);
  for (const refusal of refusals) report.issue(refusal);
  if (runtime) report.issue(runtimeAdvice(runtime));
}

/** The pre-flight's one early exit: thrown by a check, turned into `{ ok: false, gate }` by {@link preflightDeploy}. */
class DeployGate {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

interface PreflightInput {
  agentDir: string;
  config: AgentConfig;
  /** `--run` fully deploys, so a definition that resolves NO model is a GATE (a known crash-loop); else it warns. */
  run: boolean;
  /** `--force` regenerates the artifacts fastagent OWNS, so a kept `.dockerignore`'s content checks do not apply. */
  force: boolean;
  /**
   * The target holds no resident process (AgentCore): what wakes it is outside it (webhooks, alarms), so the notes
   * about keeping one machine running do not apply.
   */
  noResidentProcess?: boolean;
  /**
   * Does every deployment start this host's storage over (AgentCore)? Then a clone the instance made, and anything the
   * agent did in it, does not outlive a release. Its own question, apart from {@link noResidentProcess}.
   */
  storageResets?: boolean;
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
  const { agentDir, config, force, noResidentProcess, storageResets = false } = input;
  // The release manifest carries this name into the container, where it is joined onto the storage root — so `init`'s
  // "one path segment" is not enough here.
  if (!isReleaseAgentName(basename(agentDir))) {
    throw new DeployGate(
      `the agent directory "${basename(agentDir)}" cannot be deployed — a deployed agent directory ` +
        `may use only letters, digits, "-" and "_"; rename it (the fastagent.config.ts inside is what ` +
        `makes it an agent, never its name)`,
    );
  }

  const content = loadContent(agentDir);
  checkContent(content, storageResets, report);

  // The definition the box will load on every start, read here first: a refusal in it (a module that fails to import,
  // two tools under one name) builds a perfectly good image that crash-loops on fly/railway/docker and fails every
  // invocation on AgentCore. This is the boundary that turns that refusal into a deploy finding, so the error is
  // carried whole into the issue rather than rethrown.
  const definition = await prepareDefinition(agentDir).catch((error: unknown) => {
    report.issue(`the definition does not load, so the deployed agent would not start: ${messageOf(error)}`);
    return undefined;
  });

  // The model this deployment will run on, and where it came from. Resolved HERE so the plan side and the run side
  // cannot disagree about it.
  const valueFile = relative(agentDir, dotEnvPath(agentDir));
  const values = loadEnvValues(dotEnvPath(agentDir));
  // A host has no credential of the author's: what it clones with is GITHUB_TOKEN, which travels like every value.
  if (content.declared.length > 0 && !values.get("GITHUB_TOKEN")) {
    report.note(
      `no GITHUB_TOKEN in ${valueFile}: the host clones without a credential, which reaches public repositories ` +
        `only, and the agent cannot push from its clones. Set one there to give it access; it travels with the ` +
        `other values`,
    );
  }
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

  const declaredSecrets = definition ? definitionSecrets(definition) : declaredVariables(loadEnvironment(agentDir));
  const code = definition ? buildShapes(definition, values, report) : undefined;
  const channels = [...(code?.channels ?? [])].map(
    ([name, module]): DeclaredChannel => ({
      name,
      ingress: channelIngress(module),
    }),
  );
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
  // Counted from the registry when the code did not build: a plan that scaled to zero because a schedule failed to
  // build on deploy day would sleep through it once it is fixed.
  const hasCron = (code?.schedules.length ?? definition?.registry.schedules.length ?? 0) > 0;
  if (longConnectionChannels.length > 0 && !noResidentProcess) {
    report.note(
      `long-connection channel present (${longConnectionChannels.join(", ")}) — a GENERATED plan keeps one machine running ` +
        `(an outbound connection cannot wake a scaled-to-zero service).`,
    );
  }
  if (hasCron && !noResidentProcess) {
    report.note(
      `src/schedules/ present — a GENERATED plan keeps one machine running (nothing wakes this box at a cron instant).`,
    );
  }
  if (code !== undefined && channels.length === 0 && !hasCron) {
    report.warn(
      `no channel in src/channels/ and no schedule in src/schedules/: nothing reaches the deployed agent but its ` +
        `health check. Add a channel (\`fastagent add telegram|slack|feishu|lark\`, or your own) or a schedule; an ` +
        `agent used only from an app is embedded in it (openServing), not deployed`,
    );
  }

  const providers = code?.providers ?? [];
  if (modelSpec && code) checkModelExists(modelSpec, providers, report);
  const authPath = resolveAuthPath(agentDir);
  const route = modelSpec ? await credentialRoute(modelSpec, values, providers) : {};
  const modelAuth = route.envVar;
  const boxLogin = route.boxLogin;
  if (boxLogin !== undefined) {
    if (!hasLogin(boxLogin, providers)) {
      report.issue(
        `no credential for ${modelSpec} reaches the deployment, and "${boxLogin}" has no login to run there — set ` +
          `its API key in ${valueFile}`,
      );
    } else {
      report.note(
        `${modelSpec}: no credential ships with this deploy (this machine's logins and shell stay here) — once the ` +
          `box is up, \`--run\` asks it: it keeps what it already authenticates ${boxLogin} with, else logs in ` +
          `(\`fastagent login ${boxLogin} --deployment\`). Or set ${boxLogin}'s API key in ${valueFile}`,
      );
    }
  }

  // Container facts (shared by every host) + the warnings that follow.
  const hasPackageJson = await exists(join(agentDir, "package.json"));
  const pkg = await readPackageJson(agentDir);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(agentDir, pkg);
  if (runtime === "bun" && bunVersion !== undefined && belowFloor(bunVersion, RUNTIME_FLOOR.bun)) {
    report.issue(
      `package.json pins bun@${bunVersion}, which the image runs (oven/bun:${bunVersion}), and the agent's storage is ` +
        `node:sqlite, which Bun ships from ${RUNTIME_FLOOR.bun}: the container would fail at start. Pin ` +
        `bun@${RUNTIME_FLOOR.bun} or later`,
    );
  }
  const install = runtime === "bun" ? "bun install" : "npm install";
  const runner = runtime === "bun" ? "bun run fastagent" : "./node_modules/.bin/fastagent";
  const hasOtherLock =
    runtime === "node" &&
    ((await exists(join(agentDir, "pnpm-lock.yaml"))) || (await exists(join(agentDir, "yarn.lock"))));
  // Does the baked agent directory ship a `.git`?
  const shipsGit = await exists(join(agentDir, ".git"));
  // After the facts: the deps sentence must match the agent's actual shape (a markdown-only agent has no package.json
  // and installs nothing — the note must not point at a file that doesn't exist).
  const deps = hasPackageJson
    ? `its package.json dependencies are installed in the image`
    : `the agent has no package.json, so no deps are installed (the pinned global CLI serves the directory)`;
  // What a RELEASE does — host-neutral, because how long the storage under it lives is the host's own answer and its
  // runbook gives it (a Fly volume outlives every deploy; AgentCore's mount does not).
  report.note(
    `the agent directory is baked as the definition (WYSIWYG — what you see is what ships, git or not, clean or ` +
      `not); ${deps}. Every release replaces the deployed definition and leaves the instance's state and ` +
      `credentials in place — for how long, see this host's storage note below`,
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
  if (hasPackageJson && !listsFastagent(pkg)) {
    report.warn(
      `package.json does not list @fastagent-sh/fastagent — the image's \`${runner}\` has no local bin to run, ` +
        `so the container fails at start. Add it to dependencies and re-run \`${install}\`.`,
    );
  }
  const paths = await buildContextPaths(agentDir, authPath);
  await checkKeptIgnoreFiles({ agentDir, force, paths }, report);

  const environment = loadEnvironment(agentDir);
  const packages = environment?.packages ?? {};
  await checkEnvironment(agentDir, packages, hasPackageJson, pkg, report);
  const installsPackages = Object.keys(packages).length > 0;

  // Write-back mechanics are fastagent's (the policy is the agent's prompt's). A repository content entry is cloned on the
  // host, which takes git too. mise downloads over TLS, and the slim base image has no CA certificates; rustup, which
  // mise installs rust with, downloads with curl. The agent's own apt packages join them, in one layer.
  const needsGit = shipsGit || content.declared.length > 0;
  const apt = [
    ...new Set([
      ...(needsGit ? ["git"] : []),
      ...(installsPackages ? ["ca-certificates"] : []),
      ...(declaresTool(packages, "rust") ? ["curl"] : []),
      ...(environment?.aptPackages ?? []),
    ]),
  ];
  const container: ContainerInput = {
    releaseId: randomUUID(),
    agent: basename(agentDir),
    machineryPaths: paths.machineryPaths,
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt,
    ...(installsPackages ? { packages: packageSpecs(packages) } : {}),
    ...(model.envValue !== undefined ? { modelSpec: model.envValue } : {}),
    shipsGit,
  };
  const port = config.http?.port ?? DEFAULT_HTTP_PORT;
  await checkKeptDockerfile(agentDir, model.envValue, valueFile, report);

  return {
    channels,
    hasCron,
    values,
    valueFile,
    modelAuth,
    boxLogin,
    container,
    port,
    declaredSecrets,
    secrets: deploymentSecrets(modelAuth, declaredSecrets, values, valueFile),
  };
}

/**
 * The definition's code built for its SHAPE with the value file's values (`buildDefinitionShape`): a generate-only
 * deploy runs on a machine that may hold none of them, and whether the value file supplies them is the values gate's
 * question, asked by name. A build that fails is an issue, as a module that fails to load is.
 */
function buildShapes(
  definition: AgentDefinition,
  values: ReadonlyMap<string, string>,
  report: DeployReport,
): BuiltDefinition | undefined {
  try {
    return buildDefinitionShape(definition, Object.fromEntries(values));
  } catch (error) {
    report.issue(`the definition does not build, so the deployed agent would not start: ${messageOf(error)}`);
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A model no provider of the deployed agent offers fails every message there. */
function checkModelExists(spec: string, providers: readonly Provider[], report: DeployReport): void {
  const provider = providerOf(spec);
  if (modelsOver(new InMemoryCredentialStore(), providers).getModel(provider, spec.slice(provider.length + 1))) return;
  report.issue(
    `no provider of the deployed agent offers "${spec}" — pi-ai's built-ins and the providers fastagent.config.ts ` +
      `declares are all it has`,
  );
}

/**
 * HOW THE MODEL'S CREDENTIAL REACHES THE BOX, from what the deploy ships and nothing else. The box is the one authority
 * on what it authenticates with (pi ranks a stored login above the environment, and only the box knows what it has
 * stored, which platform variables it was given, or what role it runs as), so this never asks what authenticates the
 * model on THIS machine: its stored logins and the shell running deploy do not travel. In order:
 *
 * 1. a credential the provider reads from the value file alone (a definition's provider included, which may resolve
 *    its key from a secret it declared): its key variable (which the values gate then requires, as it does every
 *    declared name), or a keyless one such as `AWS_ACCESS_KEY_ID` — never one that needs a file, which would be this
 *    machine's;
 * 2. otherwise the box answers — `boxLogin`: after readiness, `--run` asks it, and it logs in only if it cannot
 *    already authenticate the provider.
 */
async function credentialRoute(
  spec: string,
  values: ReadonlyMap<string, string>,
  providers: readonly Provider[],
): Promise<{ envVar?: string; boxLogin?: string }> {
  const provider = providerOf(spec);
  // No file of this machine's travels, so a source that needs one (Google ADC, an AWS profile) is the box's to find.
  const fromValues = await environmentAuth(provider, Object.fromEntries(values), async () => false, providers);
  if (fromValues !== undefined) {
    return fromValues.source !== undefined && isEnvKey(fromValues.source) ? { envVar: fromValues.source } : {};
  }
  return { boxLogin: provider };
}

/** Does `provider` offer an interactive login, i.e. can `fastagent login --deployment` authenticate it on the box? */
function hasLogin(providerId: string, providers: readonly Provider[]): boolean {
  const provider = loginProviders(providers).find((p) => p.id === providerId);
  return provider !== undefined && interactiveLoginKind(provider) !== "none";
}

/**
 * What a KEPT hand-written Dockerfile drops. The environment (context.json's) is the obvious one; the resolved model is the one that
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
  /** The model the release manifest carries (set only when the value file named it). */
  modelFromValueFile: string | undefined,
  valueFile: string,
  report: DeployReport,
): Promise<void> {
  const dockerfileHome = join(agentDir, "Dockerfile");
  const dockerfileText = (await exists(dockerfileHome)) ? await readFile(dockerfileHome, "utf8") : undefined;
  if (dockerfileText === undefined || isGeneratedDockerfile(dockerfileText)) return;
  // What the image installs: the packages and apt packages. Variables travel with the value file, whatever the image.
  const environment = loadEnvironment(agentDir);
  if (Object.keys(environment?.packages ?? {}).length > 0 || (environment?.aptPackages.length ?? 0) > 0) {
    report.warn(
      `kept your hand-written Dockerfile — it installs the environment context.json declares only if it says so: ` +
        `a generated Dockerfile shows the layers (the apt packages, then \`mise install --system\` of the packages ` +
        `context.json declares).`,
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
  config: AgentConfig,
  values: ReadonlyMap<string, string>,
  /** The value file AS READ (it follows `FASTAGENT_SECRETS_DIR`), so the reported source is the real one. */
  valueFile: string,
): { spec?: string; source: string; envValue?: string; invalid?: string } {
  const fromEnv = values.get("FASTAGENT_MODEL");
  const source = fromEnv ? valueFile : "fastagent.config";
  // BOTH sources are checked, at the one point that reads them: a `provider`-less spec resolves to nothing on the
  // box, so letting `config.model` through would ship exactly the crash-loop this resolution exists to prevent —
  // the auth probe reports "unconfigured" for it here and the failure only appears after deployment.
  const spec = fromEnv || config.model;
  if (spec && !isModelSpec(spec)) return { source, invalid: spec };
  // `envValue` is what the release manifest records (ContainerInput.modelSpec), so it is set only when the value file
  // is the source: a `config.model` already travels in the config itself. The manifest is rewritten by every deploy,
  // so deleting the line and redeploying simply drops it — nothing stale survives.
  if (fromEnv) return { spec: fromEnv, source, envValue: fromEnv };
  return { spec: config.model, source };
}
