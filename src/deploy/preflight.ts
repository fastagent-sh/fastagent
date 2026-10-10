/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE the target
 * branch (Docker / Fly / Railway).
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, relative } from "node:path";
import { isModelSpec, isReleaseAgentName } from "./workspace.ts";
import { type FastagentConfig, providerOf } from "../harnesses/pi/config.ts";
import { resolveAuthPath } from "../harnesses/pi/auth.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AGENT_MODEL_CATALOG_FILE, AGENT_MODELS_FILE, exists } from "../paths.ts";
import { type DeclaredChannel, inspectChannels } from "../channels/discover.ts";
import { capSchedules, loadSchedules, MAX_SCHEDULES } from "../schedule/discover.ts";
import { resolveAgentTools } from "../harnesses/pi/create.ts";
import { loadAgentDefinition } from "../harnesses/pi/definition.ts";
import type { DeclaredContent } from "../content/declare.ts";
import { loadContent } from "../content/file.ts";
import { agentModels } from "../harnesses/pi/agent-models.ts";
import { type DeclaredSecret, allSecrets } from "../declared-secrets.ts";
import {
  createPiModelRuntime,
  definitionKeyOf,
  environmentAuthSource,
  literalKeyProviders,
  isBuiltinProvider,
  machineModels,
  globalCatalogPath,
  inGlobalCatalog,
  interactiveLoginKind,
  loginProviders,
} from "../harnesses/pi/models.ts";
import { CHANNEL_KINDS } from "../scaffold/add-channel.ts";
import { detectRuntime, listsFastagent, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";
import { buildContextPaths, checkKeptIgnoreFiles } from "./build-context.ts";
import { dotEnvPath, loadEnvValues } from "../env.ts";
import { type DeploymentSecret, deploymentSecrets, isEnvKey } from "./secrets.ts";
import { DEFAULT_HTTP_PORT, describeAnonymousSurface } from "../service.ts";
import { CONTROL_PREFIX } from "../channels/control.ts";
import {
  type DeclaredEnvironment,
  MISE_FILE,
  MISE_LOCK_FILE,
  MISE_LOCK_SIDECARS,
  readEnvironment,
} from "../environment/declare.ts";
import { lockEnvironment, MISE_PACKAGE_NAMES, miseBinary } from "../environment/mise.ts";

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
   * `schedules/` declares at least one schedule — the one residency reason with an external substitute: someone
   * else's clock calling `POST /invoke`, so an operator who wants scale-to-zero has an option here.
   */
  hasCron: boolean;
  /**
   * The deployed environment's declaration, read ONCE here so the plan side and the run side cannot disagree about
   * what this deployment carries. The environment running `deploy` is deliberately absent from it (§9).
   */
  values: ReadonlyMap<string, string>;
  /** That file, agent-dir-relative — the name every "set it here" message must use. */
  valueFile: string;
  /**
   * The variable the value file carries the model's key in (the provider's own, or a models.json `"$NAME"`), or
   * undefined when no key travels that way ({@link credentialRoute}).
   */
  modelAuth: string | undefined;
  /**
   * The provider the deployment must log in to itself (`fastagent login --deployment`): the model's credential does
   * not travel, because it is neither a variable in the value file nor carried by the definition (a models.json
   * literal `apiKey` or `!command`). Nothing from this machine's credentials file is ever copied, so a login on the
   * box is its only holder.
   */
  boxLogin: string | undefined;
  /** Every tool/channel declaration — the names the value file must supply, by declaring file. */
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
 * repository is cloned there, as on this machine without a checkout. A directory of this machine stays here: the
 * deployed agent works without it, which the line says and says how to change. One the agent works on is a warning,
 * since the deployed agent lacks data it was meant to work on; one it only knows, a note.
 */
function checkContent(content: readonly DeclaredContent[], storageResets: boolean, report: DeployReport): void {
  for (const entry of content) {
    const role = entry.readonly ? "knows" : "works on";
    if (entry.kind === "github") {
      const fate = storageResets
        ? "cloned afresh on every deployment, since the host's storage starts over; what the agent did not push is lost"
        : "cloned on the host, and brought up to date in place at each start";
      report.note(`${role} ${entry.name}: github ${entry.repo}${entry.ref ? `@${entry.ref}` : ""}, ${fate}`);
    } else if (entry.readonly) {
      report.note(
        `${role} ${entry.name}: a directory of this machine (content/${entry.name}), stays here, and the deployed ` +
          `agent works without it; to ship what the agent reads there, copy it into the agent directory outside ` +
          `content/, which every release carries`,
      );
    } else {
      report.warn(
        `${role} ${entry.name}: a directory of this machine (content/${entry.name}), stays here, and the deployed ` +
          `agent works without it; to work on it from a host, move it to a GitHub repository and declare it as github`,
      );
    }
  }
}

/**
 * What the image needs to install the environment `mise.toml` declares: the agent's own mise for linux in its
 * package.json, so the image's install brings it, and, for tools, `mise.lock`. The lock is an artifact like the
 * Dockerfile, written here from the versions this machine runs; a machine without the agent's mise installed cannot
 * write it, which is an issue (a warning without `--run`), as a code input that cannot load is.
 */
async function checkEnvironment(
  agentDir: string,
  environment: DeclaredEnvironment,
  hasPackageJson: boolean,
  pkg: { optionalDependencies?: Record<string, unknown> },
  report: DeployReport,
): Promise<void> {
  const linux = MISE_PACKAGE_NAMES.filter((name) => name.includes("-linux-"));
  const missing = linux.filter((name) => !(name in (pkg.optionalDependencies ?? {})));
  if (!hasPackageJson || missing.length > 0) {
    report.issue(
      `${MISE_FILE} declares an environment, and the image would have no mise to install it with: the agent's ` +
        `package.json does not list ${missing.join(", ")}. Run \`fastagent env install\` in the agent directory.`,
    );
    return;
  }
  // mise writes no lock for a file that declares no tools, and the image then has none to install.
  if (environment.tools.length === 0) return;
  const bin = miseBinary(agentDir);
  if (!bin) {
    report.issue(
      `the agent's mise is not installed here, so ${MISE_LOCK_FILE} cannot be written from the versions this ` +
        `machine runs, and the image installs only what the lock records. Run \`fastagent env install\` in ` +
        `${agentDir}, then deploy again.`,
    );
    return;
  }
  await lockEnvironment(agentDir, bin);
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
  config: FastagentConfig;
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
   * Does this target publish the serve at a URL anyone can dial? True for every host that mints one (Fly, Railway,
   * a Docker box); false for AgentCore, where the container is reachable only through the Runtime's IAM and the
   * forwarder's shared secret. Kept apart from {@link noResidentProcess} on purpose — they happen to agree on AgentCore
   * today, and answering two questions with one boolean is how the answer to one of them goes wrong later.
   */
  publicUrl?: boolean;
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
  const { agentDir, config, force, noResidentProcess, publicUrl = true, storageResets = false } = input;
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

  // The definition the box will load on every start, loaded here first: a refusal in it (a leftover persona.md, a
  // skill named with a slash) builds a perfectly good image that crash-loops on fly/railway/docker and fails every
  // invocation on AgentCore. This is the boundary that turns that refusal into a deploy finding, so the error is
  // carried whole into the issue rather than rethrown.
  await loadAgentDefinition(agentDir).catch((error: unknown) => {
    report.issue(
      `the definition does not load, so the deployed agent would not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  // The model this deployment will run on, and where it came from. Resolved HERE so the plan side and the run side
  // cannot disagree about it.
  const valueFile = relative(agentDir, dotEnvPath(agentDir));
  const values = loadEnvValues(dotEnvPath(agentDir));
  // A host has no credential of the author's: what it clones with is GITHUB_TOKEN, which travels like every value.
  if (content.some((entry) => entry.kind === "github") && !values.get("GITHUB_TOKEN")) {
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

  // Time triggers (schedules or self-scheduling) need a machine kept running. A file that FAILED to load still counts
  // as a trigger — the author will fix it, and a plan that scaled to zero because a cron was broken on deploy day
  // would sleep through it afterwards.
  const loadedSchedules = await loadSchedules(agentDir);

  // What the PUBLIC host URL answers with no authentication of ours, NAMED FROM WHAT WILL ACTUALLY MOUNT, never from
  // the host alone: listing an endpoint this deployment does not
  // serve is how an operator learns to skim past every deploy warning — the same reason `publicUrl` exists.
  const unauthenticated = describeAnonymousSurface({
    invoke: config.http?.invoke !== false,
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

  // A FAILED file still counts, on the conservative side: it may well be a valid schedule tomorrow, and a plan that
  // scaled to zero because the file did not parse would hide that behind silence.
  const hasCron = loadedSchedules.schedules.length > 0 || loadedSchedules.failures.length > 0;
  if (longConnectionChannels.length > 0 && !noResidentProcess) {
    report.note(
      `long-connection channel present (${longConnectionChannels.join(", ")}) — a GENERATED plan keeps one machine running ` +
        `(an outbound connection cannot wake a scaled-to-zero service).`,
    );
  }
  if (hasCron && !noResidentProcess) {
    report.note(
      `schedules/ present — a GENERATED plan keeps one machine running (nothing wakes this box at a cron instant).`,
    );
  }

  await checkMachineModels(agentDir, modelSpec, report);

  // The registry the DEPLOYED agent has (its own models.json and model catalog, nothing of the machine's), built first
  // so a malformed file stops the deploy with pi's own reason before anything below reads the file raw. No credential
  // is read for that.
  const deployed = await createPiModelRuntime({
    agentDir,
    credentials: new InMemoryCredentialStore(),
    machineLayer: false,
  });
  if (modelSpec) await checkGlobalCatalogModel(modelSpec, deployed, report);
  const authPath = resolveAuthPath(agentDir);
  // A model only the definition's extensions declare (a virtual model, or a provider one registers) is authenticated
  // by that code on the box, per request: a virtual model's credential is whichever physical model it routes to.
  // Asked of the catalog the box builds, extensions included, so deploy judges the model the box will run.
  const fromExtension = modelSpec ? await extensionDeclared(agentDir, modelSpec, deployed) : false;
  if (fromExtension && modelSpec) {
    report.note(
      `${modelSpec} is declared by the definition's extensions, which resolve its credentials on the box — deploy ` +
        `cannot check them. Set the keys the models it uses need in ${valueFile}`,
    );
  }
  const route = modelSpec && !fromExtension ? await credentialRoute(agentDir, modelSpec, values) : {};
  const modelAuth = route.envVar;
  const boxLogin = route.boxLogin;
  if (boxLogin !== undefined) {
    if (!hasLogin(boxLogin)) {
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

  const environment = readEnvironment(agentDir);
  if (environment) await checkEnvironment(agentDir, environment, hasPackageJson, pkg, report);
  // Read after the lock is written: it writes them.
  const lockSidecars = environment !== undefined && (await exists(join(agentDir, MISE_LOCK_SIDECARS)));

  // Write-back mechanics are fastagent's (the policy is the agent's prompt's). A repository content entry is cloned on the
  // host, which takes git too. mise downloads over TLS, and the slim base image has no CA certificates.
  const needsGit = shipsGit || content.some((entry) => entry.kind === "github");
  const apt = [...(needsGit ? ["git"] : []), ...(environment ? ["ca-certificates"] : [])];
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
    ...(environment ? { environment: { ...environment, lockSidecars } } : {}),
    ...(model.envValue !== undefined ? { modelSpec: model.envValue } : {}),
    shipsGit,
  };
  const port = config.http?.port ?? DEFAULT_HTTP_PORT;
  // EVERYTHING the definition declared it needs, from wherever it was declared. Read through the SAME resolver
  // dev/start mount with, so "which tool declarations count" has one answer (config.tools declare too; a shadowed
  // file's declaration is dropped in both places).
  const resolvedTools = await resolveAgentTools(config, agentDir);
  // A code input we could not READ is a code input whose declarations we cannot carry — and the box
  // WILL read it (its deps are installed there), so its gate fires after the deploy reported success:
  // a crash loop, which is the failure mode this whole mechanism exists to move to build time. Under
  // `--run` that is a gate, like a channel that fails to inspect; generate-only warns, since the
  // operator may be producing artifacts from a machine that never installed the agent's deps.
  for (const failure of resolvedTools.toolFailures) {
    const issue =
      `${failure.label} failed to load (${failure.message}) — any secrets it declares cannot be carried ` +
      `to the host, so the deployed box would refuse to start`;
    report.issue(issue);
  }
  for (const failure of loadedSchedules.failures) {
    report.issue(
      `${failure.label} is not a valid schedule (${failure.message}) — the deployed box would leave it unarmed, so ` +
        `it would never fire there`,
    );
  }
  for (const over of capSchedules(loadedSchedules.schedules).over) {
    report.issue(
      `schedules/${over.name}.md is past the first ${MAX_SCHEDULES} schedules by name — the deployed box would leave ` +
        `it unarmed, so it would never fire there`,
    );
  }
  const declaredSecrets: DeclaredSecret[] = [
    ...allSecrets(resolvedTools.toolSecrets),
    ...allSecrets(inspected.secrets),
  ];
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
 * HOW THE MODEL'S CREDENTIAL REACHES THE BOX, from what the deploy ships and nothing else. The box is the one authority
 * on what it authenticates with (pi ranks a stored login above the environment, and only the box knows what it has
 * stored, which platform variables it was given, or what role it runs as), so this never asks what authenticates the
 * model on THIS machine: its stored logins and the shell running deploy do not travel. In order:
 *
 * 1. the definition's own models.json: a `"$NAME"` reference is a variable the value file must hold (the values gate
 *    asks for it by name), and a literal or `"!command"` travels in the image;
 * 2. a credential pi reads for the provider from the value file alone: its key variable (which the values gate then
 *    requires, as it does every declared name), or a keyless one such as `AWS_ACCESS_KEY_ID` — never one that needs a
 *    file, which would be this machine's;
 * 3. otherwise the box answers — `boxLogin`: after readiness, `--run` asks it, and it logs in only if it cannot
 *    already authenticate the provider.
 */
async function credentialRoute(
  agentDir: string,
  spec: string,
  values: ReadonlyMap<string, string>,
): Promise<{ envVar?: string; boxLogin?: string }> {
  const provider = providerOf(spec);
  const declared = await definitionKeyOf(agentDir, provider);
  if (declared) return "reference" in declared ? { envVar: declared.reference } : {};
  // No file of this machine's travels, so a source that needs one (Google ADC, an AWS profile) is the box's to find.
  const fromValues = await environmentAuthSource(provider, Object.fromEntries(values), async () => false);
  if (fromValues !== undefined) return isEnvKey(fromValues) ? { envVar: fromValues } : {};
  return { boxLogin: provider };
}

/** Whether `spec` exists only once the definition's extensions have registered their models. */
async function extensionDeclared(agentDir: string, spec: string, deployed: ModelRuntime): Promise<boolean> {
  const provider = providerOf(spec);
  const id = spec.slice(provider.length + 1);
  if (deployed.getModel(provider, id)) return false;
  const catalog = await agentModels(
    agentDir,
    { credentialStore: new InMemoryCredentialStore() },
    { machineLayer: false },
  ).runtime();
  return catalog.getModel(provider, id) !== undefined;
}

/** Does `provider` offer an interactive login, i.e. can `fastagent login --deployment` authenticate it on the box? */
function hasLogin(providerId: string): boolean {
  const provider = loginProviders().find((p) => p.id === providerId);
  return provider !== undefined && interactiveLoginKind(provider) !== "none";
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
 * The machine's model catalog is this box's environment, like its models.json: a model only it knows (newer than the
 * catalog bundled with pi) is unknown wherever the agent is deployed. The agent's own catalog ships, so the remedy is
 * one refresh in the agent.
 */
async function checkGlobalCatalogModel(modelSpec: string, deployed: ModelRuntime, report: DeployReport): Promise<void> {
  const provider = providerOf(modelSpec);
  const id = modelSpec.slice(provider.length + 1);
  if (deployed.getModel(provider, id) || !(await inGlobalCatalog(provider, id))) return;
  report.issue(
    `model "${modelSpec}" is known only from ${globalCatalogPath()}, the machine's model catalog, which does not ` +
      "ship — the deployed agent would fail with an unknown model. Run `fastagent models --refresh` in the agent " +
      `to record it in its own ${AGENT_MODEL_CATALOG_FILE}, which ships.`,
  );
}

/**
 * What a KEPT hand-written Dockerfile drops. The environment (mise.toml) is the obvious one; the resolved model is the one that
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
  if (readEnvironment(agentDir)) {
    report.warn(
      `kept your hand-written Dockerfile — it installs the environment ${MISE_FILE} declares only if it says so: ` +
        `a generated Dockerfile shows the layers (system packages, then \`mise --locked install\`).`,
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
  // the auth probe reports "unconfigured" for it here and the failure only appears after deployment.
  const spec = fromEnv || config.model;
  if (spec && !isModelSpec(spec)) return { source, invalid: spec };
  // `envValue` is what the release manifest records (ContainerInput.modelSpec), so it is set only when the value file
  // is the source: a `config.model` already travels in the config itself. The manifest is rewritten by every deploy,
  // so deleting the line and redeploying simply drops it — nothing stale survives.
  if (fromEnv) return { spec: fromEnv, source, envValue: fromEnv };
  return { spec: config.model, source };
}
