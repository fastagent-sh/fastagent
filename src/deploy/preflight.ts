/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE the target
 * branch (Docker / Fly / Railway).
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isModelSpec } from "../model-ref.ts";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { resolveAuthPath } from "../harnesses/models/credentials.ts";
import {
  environmentAuth,
  interactiveLoginKind,
  keyVariables,
  listModels,
  loginProviders,
  modelHint,
  modelsOver,
  providerOf,
} from "../harnesses/models/models.ts";
import { modelEnvironment } from "../harnesses/models/environment.ts";
import { type EffectiveConfig, type InstanceConfigSource, instanceConfigIn } from "../harnesses/pi-durable/config.ts";
import { type AgentDefinition, definitionSecrets } from "../harnesses/pi-durable/definition.ts";
import { type BuiltDefinition, buildDefinitionShape, loadSourceDefinition } from "../harnesses/pi-durable/open.ts";
import { INSTANCE_CONFIG_FILE, exists } from "../paths.ts";
import { type DeclaredChannel, channelIngress } from "../channels/discover.ts";
import type { DeclaredContent } from "../content/declare.ts";
import { loadContent, loadEnvironment } from "../content/file.ts";
import type { DeclaredSecret } from "../declared-secrets.ts";
import { CHANNEL_KINDS } from "../scaffold/add-channel.ts";
import { RUNTIME_FLOOR, belowFloor, detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";
import { deliveredConfig, undeliverableText } from "./delivery.ts";
import {
  type McpDeclaration,
  declareMcp,
  literalCredentialAdvice,
  literalCredentials,
  relativeCommands,
} from "../mcp/config.ts";
import { buildContextPaths, checkKeptIgnoreFiles } from "./build-context.ts";
import { dotEnvPath, loadEnvValues } from "../value-file.ts";
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
   * The variables the model's provider reads its key from, and whether the deployment needs one of them set on its
   * target: when no key is in the value file and the provider has no login to run on the box, the key is the only way in.
   */
  modelKey: { variables: string[]; required: boolean };
  /**
   * The provider the deployment must log in to itself (`fastagent login --deployment`): the model's credential does
   * not travel, because it is neither a variable in the value file nor resolved by the definition's own provider code.
   * Nothing from this machine's credentials file is ever copied, so a login on the box is its only holder.
   */
  boxLogin: string | undefined;
  /** Every declaration the definition makes — the names the target must hold, by declaring file. */
  declaredSecrets: readonly DeclaredSecret[];
  /** The runbook's variable list: the declared names, each hinted by the file that declared it. */
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

/** What a host's clone of a `github` entry reads; optional, since a public repository needs none. */
const GITHUB_TOKEN_SECRET: DeclaredSecret = {
  name: "GITHUB_TOKEN",
  declaredIn: "context.json (a github content entry)",
  description: "git's credential for a private repository, and for the agent to push",
  optional: true,
};

/**
 * The MCP servers the box will open: the program's, in the image, and the delivered configuration's. A name both
 * declare, or one that cannot be read, is an issue (the box would refuse to open); a literal credential in the
 * program's is a warning, since it ships in the image; in the delivered configuration it is an issue, since a host
 * renders that into a manifest meant to be committed and shows it on the platform (FastAgent cannot tell a secret from
 * a setting, so each literal value is refused and `${VAR}` is the way out); a relative stdio command in the delivered
 * configuration is an issue, since nothing delivers the script it names. (The program's own is relative to its
 * package, and `build` refuses one that it does not copy.)
 * `args` are not checked: FastAgent cannot know which strings are paths. Answers whether the list reads.
 */
function checkMcp(agentDir: string, delivered: InstanceConfigSource | undefined, report: DeployReport): boolean {
  let declarations: McpDeclaration[];
  try {
    declarations = declareMcp(agentDir, delivered);
  } catch (error) {
    report.issue(messageOf(error));
    return false;
  }
  for (const literal of literalCredentials(declarations)) {
    const where = `${literal.file} mcpServers.${literal.server}.${literal.field}.${literal.key}`;
    const advice = `${literalCredentialAdvice(literal)} and set that name with \`fastagent secrets set <host> <NAME>\``;
    if (literal.origin === "instance") {
      report.issue(
        `${where} is a literal value, and this deploy writes the configuration into a manifest meant to be committed ` +
          `and shows it on the platform: ${advice}`,
      );
    } else {
      report.warn(`${where} is a literal value, and this deploy puts it in the image: ${advice}`);
    }
  }
  for (const { name, file, command } of relativeCommands(declarations).filter(({ origin }) => origin === "instance")) {
    report.issue(
      `${file} mcpServers.${name}: the command "${command}" is a relative path, and a deploy delivers the configuration ` +
        `but not the script it names: write an absolute path on the box, or a command found on its PATH`,
    );
  }
  return true;
}

/**
 * What each content entry becomes on the host, one line each, so none is missing there unsaid (agent-model.md §3). A
 * repository, the program's or the delivered configuration's, is cloned there. A directory of this machine is not on
 * the host, and FastAgent maps none onto it, so the delivered configuration naming one is an issue: the deployed agent
 * would lack data it was configured to work on.
 */
function checkContent(
  declared: readonly DeclaredContent[],
  delivered: string | undefined,
  storageResets: boolean,
  report: DeployReport,
): void {
  const fate = storageResets
    ? "cloned afresh on every deployment, since the host's storage starts over; what the agent did not push is lost"
    : "cloned on the host, and brought up to date in place at each start";
  for (const entry of declared) {
    if (entry.kind === "github") {
      report.note(`works on ${entry.name}: github ${entry.repo}${entry.ref ? `@${entry.ref}` : ""}, ${fate}`);
      continue;
    }
    report.issue(
      `works on ${entry.name}: a directory of this machine (${entry.path}), in ${delivered}, which the host does not ` +
        `have: declare a repository instead (github:owner/repo), or copy what the agent only needs to read into the ` +
        `agent directory, which every release carries`,
    );
  }
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
  pkg: { optionalDependencies?: Record<string, unknown> },
  report: DeployReport,
): Promise<void> {
  if (Object.keys(packages).length === 0) return;
  const linux = MISE_PACKAGE_NAMES.filter((name) => name.includes("-linux-"));
  const missing = linux.filter((name) => !(name in (pkg.optionalDependencies ?? {})));
  if (missing.length > 0) {
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
  /** The instance's name (`deploymentName`): the agent the box's storage will belong to. */
  name: string;
  config: EffectiveConfig;
  /** The instance configuration this deployment delivers (`--config`), as read. */
  delivered?: { source: InstanceConfigSource };
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
  /** Does this deployment serve the Agent API under `/v1` (deploy/api.ts)? Then a Caller with its key reaches it. */
  servesApi?: boolean;
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
  const { agentDir, config, delivered, force, noResidentProcess, storageResets = false, servesApi = false } = input;

  // A deployed agent is built (`start` opens `dist/`), and a build needs the project's own manifest and TypeScript.
  if (!(await exists(join(agentDir, "package.json")))) {
    throw new DeployGate(
      `the agent directory has no package.json, and a deployed agent is built: \`fastagent build\` needs one with ` +
        `"type": "module" and typescript (\`fastagent init\` writes both)`,
    );
  }

  const content = loadContent(agentDir, delivered?.source);
  checkContent(content, delivered?.source.label, storageResets, report);
  const textProblem = delivered === undefined ? undefined : undeliverableText(delivered.source);
  if (textProblem !== undefined) report.issue(textProblem);
  const mcpOpens = checkMcp(agentDir, delivered?.source, report);
  // The project's own, the development instance's: a deploy carries only the configuration it is given.
  const own = await instanceConfigIn(agentDir);
  if (own !== undefined && own.label !== delivered?.source.label) {
    report.note(
      `${INSTANCE_CONFIG_FILE} is the development instance's configuration and a deploy does not carry it` +
        (delivered === undefined ? ": pass --config <file> to deliver one" : `; it carries ${delivered.source.label}`),
    );
  }

  // The definition the box will load on every start, read here first: a refusal in it (a module that fails to import,
  // two tools under one name) builds a perfectly good image that crash-loops on fly/railway/docker and fails every
  // invocation on AgentCore. This is the boundary that turns that refusal into a deploy finding, so the error is
  // carried whole into the issue rather than rethrown.
  const definition = await loadSourceDefinition(agentDir).catch((error: unknown) => {
    report.issue(`the definition does not load, so the deployed agent would not start: ${messageOf(error)}`);
    return undefined;
  });

  // The model this deployment will run on, and where it came from. Resolved HERE so the plan side and the run side
  // cannot disagree about it.
  const valueFile = relative(agentDir, dotEnvPath(agentDir));
  const values = loadEnvValues(dotEnvPath(agentDir));
  // A host has no credential of the author's: what it clones with is GITHUB_TOKEN, a value of the target like any other.
  // This reads this machine's file only, so a target that already holds one is told as much.
  if (content.length > 0 && !values.get("GITHUB_TOKEN")) {
    report.note(
      `no GITHUB_TOKEN in ${valueFile}: unless the target holds one, the host clones without a credential, which ` +
        `reaches public repositories only, and the agent cannot push from its clones. \`fastagent secrets set <host> ` +
        `GITHUB_TOKEN\` gives it access`,
    );
  }
  const model = resolveDeployModel(config, values, valueFile);
  if (model.invalid !== undefined) {
    // A gate rather than a warning even without `--run`: a spec the box cannot resolve is a crash loop that no
    // artifact can say otherwise.
    throw new DeployGate(
      `the model in ${model.source} is not a "provider/modelId" spec: ${JSON.stringify(model.invalid)}`,
    );
  }
  if (!model.spec) {
    const issue =
      `no model resolves for this deployment — set \`defaults: { model: "provider/id" }\` in fastagent.config.ts (it travels ` +
      `in the image), \`model\` in the configuration --config delivers, or FASTAGENT_MODEL in ${valueFile} (deploy delivers that one in the configuration)` +
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

  const declaredSecrets = [
    ...(definition
      ? definitionSecrets(definition, config, mcpOpens ? delivered?.source : undefined)
      : declaredVariables(loadEnvironment(agentDir))),
    // The host's clone of a github entry reads it, so `secrets list|push|set` and `deploy` know the name.
    ...(content.some((entry) => entry.kind === "github") ? [GITHUB_TOKEN_SECRET] : []),
  ];
  const code = definition ? buildShapes(definition, values, config, report) : undefined;
  const channels = [...(code?.channels ?? [])].map(
    ([name, module]): DeclaredChannel => ({
      name,
      ingress: channelIngress(module),
    }),
  );
  for (const { name, ingress } of channels) {
    if ((CHANNEL_KINDS as string[]).includes(name)) continue;
    const secretsPart = `the variables it declares are the target's to hold (\`fastagent secrets\`), like every other`;
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
  if (code !== undefined && channels.length === 0 && !hasCron && !servesApi) {
    report.warn(
      `no channel in src/channels/, no schedule in src/schedules/, and no Agent API on this deployment: nothing ` +
        `reaches it but its health check. Add a channel (\`fastagent add telegram|slack|feishu|lark\`, or your ` +
        `own) or a schedule; an agent used only from an app is embedded in it (openAgent), not deployed`,
    );
  }

  const providers = code?.providers ?? [];
  const authPath = resolveAuthPath(agentDir);
  const route = modelSpec ? await credentialRoute(modelSpec, values, providers) : {};
  const modelAuth = route.envVar;
  const boxLogin = route.boxLogin;
  if (modelSpec && code) {
    await checkModelExists(agentDir, modelSpec, providers, report, {
      credentialShips: boxLogin === undefined,
      valueFile,
    });
  }
  const modelProvider = modelSpec ? loginProviders(providers).find((p) => p.id === providerOf(modelSpec)) : undefined;
  const modelKey = {
    variables: modelProvider ? await keyVariables(modelProvider) : [],
    required: boxLogin !== undefined && !hasLogin(boxLogin, providers),
  };
  if (boxLogin !== undefined) {
    if (modelKey.required) {
      report.note(
        `${modelSpec}: "${boxLogin}" has no login to run on the box, so its API key (${modelKey.variables.join(" or ")}) ` +
          `must be set on the target`,
      );
    } else {
      report.note(
        `${modelSpec}: no credential ships with this deploy (this machine's logins and shell stay here) — once the ` +
          `box is up, \`--run\` asks it: it keeps what it already authenticates ${boxLogin} with, else logs in ` +
          `(\`fastagent login ${boxLogin} --deployment\`). Or set ${boxLogin}'s API key on the target ` +
          `(\`fastagent secrets set <host> ${modelKey.variables[0] ?? "<KEY_NAME>"}\`)`,
      );
    }
  }

  // Container facts (shared by every host) + the warnings that follow.
  const pkg = await readPackageJson(agentDir);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(agentDir, pkg);
  const kept = await keptDockerfile(agentDir);
  // Only the generated image runs the pinned Bun: a hand-written Dockerfile names its own base.
  if (
    kept === undefined &&
    runtime === "bun" &&
    bunVersion !== undefined &&
    belowFloor(bunVersion, RUNTIME_FLOOR.bun)
  ) {
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
  // What a RELEASE does — host-neutral, because how long the storage under it lives is the host's own answer and its
  // runbook gives it (a Fly volume outlives every deploy; AgentCore's mount does not).
  report.note(
    `the agent directory is baked as the definition (WYSIWYG — what you see is what ships, git or not, clean or ` +
      `not); its package.json dependencies are installed in the image. Every release replaces the image and leaves the instance's working directory, state and ` +
      `credentials in place on the storage — for how long, see this host's storage note below`,
  );
  // A code agent with no lockfile builds via a non-frozen install (ranges resolve at build time) — not reproducible.
  if (!hasLockfile) {
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
  if (!listsFastagent(pkg)) {
    report.warn(
      `package.json does not list @fastagent-sh/fastagent — the image's \`${runner}\` has no local bin to run, ` +
        `so the container fails at start. Add it to dependencies and re-run \`${install}\`.`,
    );
  }
  const paths = await buildContextPaths(agentDir, authPath);
  await checkKeptIgnoreFiles({ agentDir, force, paths }, report);

  const environment = loadEnvironment(agentDir);
  const packages = environment?.packages ?? {};
  await checkEnvironment(agentDir, packages, pkg, report);
  const installsPackages = Object.keys(packages).length > 0;

  // Write-back mechanics are fastagent's (the policy is the agent's prompt's). A repository content entry is cloned on the
  // host, which takes git too. mise downloads over TLS, and the slim base image has no CA certificates; rustup, which
  // mise installs rust with, downloads with curl. The agent's own apt packages join them, in one layer.
  const needsGit = shipsGit || content.length > 0;
  const apt = [
    ...new Set([
      ...(needsGit ? ["git"] : []),
      ...(installsPackages ? ["ca-certificates"] : []),
      ...(declaresTool(packages, "rust") ? ["curl"] : []),
      ...(environment?.aptPackages ?? []),
    ]),
  ];
  const container: ContainerInput = {
    agent: input.name,
    ...(delivered === undefined ? {} : { configFile: delivered.source.label }),
    machineryPaths: paths.machineryPaths,
    runtime,
    bunVersion,
    hasLockfile,
    apt,
    ...(installsPackages ? { packages: packageSpecs(packages) } : {}),
    config: deliveredConfig(delivered?.source.values, model.fromValueFile),
    shipsGit,
  };
  const port = config.http?.port ?? DEFAULT_HTTP_PORT;
  if (kept !== undefined) checkKeptDockerfile(kept, agentDir, report);

  return {
    channels,
    hasCron,
    values,
    valueFile,
    modelAuth,
    modelKey,
    boxLogin,
    container,
    port,
    declaredSecrets,
    secrets: deploymentSecrets(modelAuth, declaredSecrets),
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
  config: EffectiveConfig,
  report: DeployReport,
): BuiltDefinition | undefined {
  try {
    return buildDefinitionShape(definition, Object.fromEntries(values), config);
  } catch (error) {
    report.issue(`the definition does not build, so the deployed agent would not start: ${messageOf(error)}`);
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A model no provider of the deployed agent offers fails every message there. Its lists are this machine's: what it
 * kept and what it fetches now, a provider's own list with whatever credential this machine's environment holds. A
 * model only a fetched list has is the box's only once the box fetches that list, which a box with nothing kept does as
 * it opens: pi's published catalog with no credential, a provider's own list with the one this deploy carries, since a
 * login on the box comes after the start it would refuse. Whether a model is only in a provider's own list cannot be
 * told here: a provider in code keeps what it fetched in its own object, which every `Models` over it then lists.
 */
async function checkModelExists(
  agentDir: string,
  spec: string,
  providers: readonly Provider[],
  report: DeployReport,
  box: { credentialShips: boolean; valueFile: string },
): Promise<void> {
  const provider = providerOf(spec);
  const modelId = spec.slice(provider.length + 1);
  const { models } = await modelEnvironment(agentDir, { credentialStore: new InMemoryCredentialStore() }, providers);
  if (models.getModel(provider, modelId)) {
    if (models.getProvider(provider)?.refreshModels !== undefined) {
      if (box.credentialShips) return;
      report.warn(
        `provider "${provider}" fetches its own model list, which a box with no list kept, as on a first deploy, ` +
          `fetches as it starts, with a credential this deploy does not carry (a login on the box comes after the ` +
          `start): if "${spec}" is only in that list, the box refuses to start on it until ${provider}'s API key is ` +
          `in ${box.valueFile}`,
      );
      return;
    }
    if (modelsOver(new InMemoryCredentialStore(), providers).getModel(provider, modelId)) return;
    report.warn(
      `"${spec}" is in pi's published catalog, not in the pi-ai this FastAgent carries: a box with no catalog kept, ` +
        `as on a first deploy, fetches it from pi.dev as it starts, and refuses to start on "${spec}" if it cannot`,
    );
    return;
  }
  report.issue(
    `no provider of the deployed agent offers "${spec}": ${modelHint(listModels(models), spec)}. Its providers are ` +
      `pi-ai's built-ins, pi's published catalog and the ones fastagent.config.ts declares`,
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

/** The agent's hand-written Dockerfile, which the deploy keeps; undefined when there is none, or it is the generated one. */
async function keptDockerfile(agentDir: string): Promise<string | undefined> {
  const path = join(agentDir, "Dockerfile");
  const text = (await exists(path)) ? await readFile(path, "utf8") : undefined;
  return text === undefined || isGeneratedDockerfile(text) ? undefined : text;
}

/**
 * What a KEPT hand-written Dockerfile drops: the environment (context.json's) that the generated one installs, and the
 * build `start` opens. (The instance's configuration and name are variables on the host, not part of any image.)
 */
function checkKeptDockerfile(dockerfileText: string, agentDir: string, report: DeployReport): void {
  // What the image installs: the packages and apt packages. Variables are the target's, whatever the image.
  const environment = loadEnvironment(agentDir);
  if (Object.keys(environment?.packages ?? {}).length > 0 || (environment?.aptPackages.length ?? 0) > 0) {
    report.warn(
      `kept your hand-written Dockerfile — it installs the environment context.json declares only if it says so: ` +
        `a generated Dockerfile shows the layers (the apt packages, then \`mise install --system\` of the packages ` +
        `context.json declares).`,
    );
  }
  // `start` opens dist/. Docker and Fly upload the directory as it is, but `railway up` follows .gitignore, which the
  // scaffold gives `/dist`: without a build step of its own the image has none, and the box does not start.
  if (!/\bfastagent(?:\s+run)?\s+build\b|\bnpm\s+run\s+build\b/.test(dockerfileText)) {
    report.warn(
      `your Dockerfile does not run \`fastagent build\`: \`start\` opens dist/, which an upload that follows ` +
        `.gitignore (Railway) leaves out. Add \`RUN ./node_modules/.bin/fastagent build\` after copying the agent.`,
    );
  }
}

/**
 * WHICH model this deployment runs on, and where that came from.
 *
 * There is ONE precedence chain — `flag > environment > config.model` — and this is it evaluated in the environment
 * BEING DEPLOYED rather than in this machine's. That environment is declared by the value file, so the operator's
 * `process.env` simply is not part of it (the same way `dev` never reads another machine's shell); it needs no rule
 * of its own. `deploy` has no flag layer: a flag would vanish on the next run that omits it, and a file does not.
 *
 * The value file's model travels as the delivered configuration's `model` (`deliveredConfig`), which every deploy
 * rewrites whole, so deleting the line and redeploying drops it: nothing stale outlives it on the host.
 */
function resolveDeployModel(
  config: EffectiveConfig,
  values: ReadonlyMap<string, string>,
  /** The value file AS READ (it follows `FASTAGENT_SECRETS_DIR`), so the reported source is the real one. */
  valueFile: string,
): { spec?: string; source: string; fromValueFile?: string; invalid?: string } {
  const fromEnv = values.get("FASTAGENT_MODEL");
  const source = fromEnv ? valueFile : "fastagent.config";
  // BOTH sources are checked, at the one point that reads them: a `provider`-less spec resolves to nothing on the
  // box, so letting `config.model` through would ship exactly the crash-loop this resolution exists to prevent —
  // the auth probe reports "unconfigured" for it here and the failure only appears after deployment.
  const spec = fromEnv || config.model;
  if (spec && !isModelSpec(spec)) return { source, invalid: spec };
  if (fromEnv) return { spec: fromEnv, source, fromValueFile: fromEnv };
  return { spec: config.model, source };
}
