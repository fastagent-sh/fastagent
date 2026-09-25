/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE the target
 * branch (Docker / Fly / Railway).
 */
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import { isModelSpec, isReleaseAgentName } from "./workspace.ts";
import { type FastagentConfig, providerOf, resolveAuthPath } from "../engines/pi/config.ts";
import {
  AGENT_MODELS_FILE,
  type ResolvedPlacement,
  resolveSecretsDir,
  resolveStateRoot,
  exists,
  readTextIfExists,
} from "../paths.ts";
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
import { type ContainerInput, isGeneratedDockerfile, isGeneratedDockerignore } from "./container.ts";
import { dotEnvPath, loadEnvValues } from "../env.ts";
import { type DeploymentSecret, deploymentSecrets, isEnvKey } from "./secrets.ts";
import { shouldServeRun } from "../service.ts";

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
 * "Would docker's packer drop this path?" — built from a `.dockerignore`'s text via the `ignore` matcher (the same
 * library the workspace ignore files use), so `!` negation and last-match-wins are the library's problem, not ours.
 */
function dockerignoreMatcher(text: string): (path: string) => boolean {
  const anchored = text
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return line;
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      if (pattern.startsWith("/") || pattern.startsWith("**/")) return line;
      return `${negated ? "!" : ""}/${pattern}`;
    })
    .join("\n");
  const matcher = ignore({ ignorecase: false }).add(anchored);
  return (path) => matcher.ignores(path);
}

/** Run the host-neutral pre-flight. */
export async function preflightDeploy(input: {
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
}): Promise<DeployPreflight> {
  const {
    placement: { agentDir, workspace },
    config,
    run,
    force,
    externalClock,
    publicUrl = true,
  } = input;
  // The release manifest carries this name into the container, where it is joined onto the storage root — so `init`'s
  // "one path segment" is not enough here.
  if (!isReleaseAgentName(basename(agentDir))) {
    return {
      ok: false,
      gate:
        `the agent directory "${basename(agentDir)}" cannot be deployed — a deployed agent directory ` +
        `may use only letters, digits, "-" and "_"; rename it (the fastagent.config.ts inside is what ` +
        `makes it an agent, never its name)`,
    };
  }
  const agentPrefix = `${basename(agentDir)}/`;
  const messages: DeployMessage[] = [];

  // The model this deployment will run on, and where it came from. Resolved HERE so the plan side and the run side
  // cannot disagree about it.
  const valueFile = relative(workspace, dotEnvPath(agentDir));
  const values = loadEnvValues(dotEnvPath(agentDir));
  const model = resolveDeployModel(config, values, valueFile);
  if (model.invalid !== undefined) {
    // A gate rather than a warning even without `--run`: the release manifest validates the spec on the way out, so
    // there is no artifact to produce either. Same class as the agent-directory-name gate above.
    return {
      ok: false,
      gate: `the model in ${model.source} is not a "provider/modelId" spec: ${JSON.stringify(model.invalid)}`,
    };
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
    if (run) return { ok: false, gate: issue };
    messages.push({ level: "warn", text: issue });
  } else {
    messages.push({ level: "note", text: `model ${model.spec} (source: ${model.source})` });
  }
  const modelSpec = model.spec;

  // Time triggers (static routines or self-scheduling) need a machine kept running, and a declared schedule also
  // decides whether `POST /run` mounts — so the load happens HERE, before the warning that has to name it.
  // Loaded, not just listed: the same load answers "are there time triggers" AND "what did they declare they need".
  // A file that FAILED to load still counts as a trigger — the author will fix it, and a plan that scaled to zero
  // because a cron was broken on deploy day would sleep through it afterwards.
  const loadedRoutines = await loadRoutines(agentDir);

  // What the PUBLIC host URL answers with no authentication of ours in front of it — NAMED FROM WHAT WILL ACTUALLY
  // MOUNT, never from the host alone. `POST /invoke` is on by default whatever channels a definition declares (so
  // this is not conditioned on `sessionControl`), but `http.invoke: false` withholds it. Listing an endpoint this deployment does not serve
  // is how an operator learns to skim past every deploy warning — the same reason `publicUrl` exists.
  //
  // `POST /run` follows the SAME condition the assembly uses, through the same function
  // (`shouldServeRun`). Leaving it out had the two failures this list exists to prevent —
  // one missing endpoint in the ordinary case, and complete silence for `http.invoke: false` + `http.run: true`,
  // which is a public URL whose ONLY anonymous turn endpoint went unmentioned.
  const servesRun =
    loadedRoutines.routines.length > 0 &&
    shouldServeRun({ serveInvoke: config.http?.invoke, serveRun: config.http?.run });
  const unauthenticated = [
    ...(config.http?.invoke === false ? [] : ["POST /invoke (run a turn with this agent's tools)"]),
    ...(servesRun ? ["POST /run (run any routine this agent declares; GET /routines lists them)"] : []),
    ...(config.sessionControl === true ? ["/control/* (read, steer or delete any session)"] : []),
  ];
  if (publicUrl && unauthenticated.length > 0) {
    messages.push({
      level: "warn",
      text:
        `the deployed box answers ${unauthenticated.join(" and ")} at its public URL, UNAUTHENTICATED — ` +
        `fastagent authenticates nothing. Put a gateway, an IdP-backed proxy or a private network in front of that ` +
        `URL (docs/design/session-control.md §14)`,
    });
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
    messages.push({
      level: "note",
      text:
        ingress === "long-connection"
          ? `long-connection channel "${name}" is custom — ${secretsPart}; generated deploy plans keep the process running and skip webhook registration`
          : `route channel "${name}" is custom — ${secretsPart}; configure its webhook yourself`,
    });
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
    messages.push({
      level: "note",
      text:
        `long-connection channel present (${longConnectionChannels.join(", ")}) — a GENERATED plan keeps one machine running ` +
        `(an outbound connection cannot wake a scaled-to-zero service).`,
    });
  }
  // A cron has an external substitute, and an operator who is paying for an idle box should be told so.
  if (hasCron && !externalClock) {
    messages.push({
      level: "note",
      text:
        `routines/ present — a GENERATED plan keeps one machine running (nothing wakes this box at a cron ` +
        `instant). To scale to zero instead, keep the time in a scheduler you own and let it call ` +
        `\`POST /run\` (an API that runs one declared unit of work by name — docs/api-reference.md#post-run).`,
    });
  }

  // The machine's models.json is this box's environment, not the artifact: whatever the model takes from it is
  // absent wherever the agent is deployed. Said in so many words here; the credential probe below already reads the
  // deployed registry.
  const machine = await machineModels(agentDir);
  const provider = modelSpec ? providerOf(modelSpec) : undefined;
  const fromMachine = provider !== undefined && machine?.inherited.includes(provider) === true;
  if (fromMachine && provider !== undefined && machine) {
    if (isBuiltinProvider(provider)) {
      messages.push({
        level: "warn",
        text:
          `model "${modelSpec}" takes its "${provider}" entry from ${machine.path}, the machine's models.json, which ` +
          `does not ship — the deployed agent runs pi's built-in "${provider}" without it. Declare the entry in the ` +
          `agent's own ${AGENT_MODELS_FILE} to deploy it.`,
      });
    } else {
      // No built-in to fall back on: the deployed agent cannot resolve the model at all.
      const issue =
        `model "${modelSpec}" exists only in ${machine.path}, the machine's models.json, which does not ship — the ` +
        `deployed agent would fail with an unknown model. Declare "${provider}" in the agent's own ` +
        `${AGENT_MODELS_FILE} to deploy it.`;
      if (run) return { ok: false, gate: issue };
      messages.push({ level: "warn", text: issue });
    }
  }

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
    messages.push({
      level: "warn",
      text:
        `${AGENT_MODELS_FILE} carries a literal apiKey for ${literalKeys.map((id) => `"${id}"`).join(", ")} — that ` +
        `file ships inside the image, where anyone who can pull it reads the layer. If it is a credential, use ` +
        `"$YOUR_ENV_VAR" (deploy carries it like any provider key) or "!command" (it runs on the box and never ` +
        `travels); a placeholder for a keyless local server is fine as it is.`,
    });
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
  messages.push({
    level: "note",
    text:
      `the whole directory is baked as the agent's workspace (WYSIWYG — what you see is what ships, ` +
      `git or not, clean or not); ${deps}. The image seeds the storage once; a later release replaces ` +
      `only ${agentPrefix} and leaves the rest of the workspace, state and credentials in place — for ` +
      `how long, see this host's storage note below`,
  });
  // A code agent with no lockfile builds via a non-frozen install (ranges resolve at build time) — not reproducible.
  if (hasPackageJson && !hasLockfile) {
    const lock = runtime === "bun" ? "bun.lock" : "package-lock.json";
    messages.push({
      level: "warn",
      text: hasOtherLock
        ? `the generated Dockerfile is npm-based — your pnpm/yarn lockfile is NOT used (build runs ` +
          `\`npm install\`, not reproducible). Edit the Dockerfile for your package manager, or vendor a package-lock.json.`
        : `no ${lock} — the image build resolves deps at build time (not reproducible). ` +
          `Run \`${install}\` and commit the lockfile for pinned redeploys.`,
    });
  }
  // The code-path Dockerfile runs `${runner}`.
  if (hasPackageJson && !("@fastagent-sh/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies })) {
    messages.push({
      level: "warn",
      text:
        `package.json does not list @fastagent-sh/fastagent — the image's \`${runner}\` has no local bin to run, ` +
        `so the container fails at start. Add it to dependencies and re-run \`${install}\`.`,
    });
  }
  // A KEPT workspace-root .dockerignore silently replaces the generated one's protections.
  const inContext = (p: string): string | undefined => {
    const rel = relative(workspace, p);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
  };
  // The secrets DIR is the unit of RESPONSIBILITY, but never the unit of the leak QUESTION below.
  const secretsRel = inContext(resolveSecretsDir(agentDir));
  const authRel = inContext(authPath);
  const authElsewhere = authRel !== undefined && (secretsRel === undefined || !authRel.startsWith(`${secretsRel}/`));
  const secretPaths = [...(secretsRel ? [secretsRel] : []), ...(authElsewhere ? [authRel] : [])];
  // ONE rule for every checked path: a file that is not there cannot be baked, so gating on it would be a refusal
  // about a spelling rather than about what would ship (an agent that has never run `login` has no auth.json).
  const present = async (rels: string[]): Promise<string[]> => {
    const found: string[] = [];
    for (const rel of rels) if (await exists(join(workspace, rel))) found.push(rel);
    return found;
  };
  // State gets the same treatment (a custom in-tree FASTAGENT_STATE_DIR is invisible to the name-based `**/.state`),
  // at warn level.
  const stateRel = inContext(resolveStateRoot(agentDir));
  // Existence gates the WARNING, never the generated exclude (same split as secretPaths vs leakCandidates).
  const stateShips = stateRel !== undefined && (await exists(join(workspace, stateRel))) ? stateRel : undefined;
  // The `.env` family at the two levels fastagent is RESPONSIBLE for: the agent dir and the workspace root.
  const dotEnvFiles = async (relDir: string): Promise<string[]> => {
    const names = await readdir(join(workspace, relDir || ".")).catch(() => [] as string[]);
    // POSIX separators, like every other context-relative path here (`inContext`).
    return names
      .filter((n) => (n === ".env" || n.startsWith(".env.")) && n !== ".env.example")
      .map((n) => join(relDir, n).split(sep).join("/"));
  };
  const envFiles = (await Promise.all([...new Set(["", agentPrefix])].map(dotEnvFiles))).flat();
  // Everything ACTUALLY inside the secrets dir, minus the two tracked scaffolds the image ships on purpose (they
  // carry no values; the generated ignore re-includes them by name).
  const secretDirFiles = async (dirRel: string): Promise<string[]> => {
    const entries = await readdir(join(workspace, dirRel), { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".gitignore" || entry.name === ".env.example") continue;
      if (entry.isDirectory()) files.push(...(await secretDirFiles(`${dirRel}/${entry.name}`)));
      else files.push(`${dirRel}/${entry.name}`);
    }
    return files;
  };
  const leakCandidates = [
    ...(secretsRel ? await secretDirFiles(secretsRel) : []),
    ...(await present(authElsewhere && authRel !== undefined ? [authRel] : [])),
    ...envFiles,
  ];
  // Same existence rule: a node_modules that is not there cannot be uploaded.
  const depDirs = await present([...new Set([`${agentPrefix}node_modules`, "node_modules"])]);
  const machineryPaths = [...secretPaths, ...(stateRel ? [stateRel] : [])];

  // BOTH ignore files deploy emits get the same interrogation.
  for (const rel of [".dockerignore", `${agentPrefix}Dockerfile.dockerignore`]) {
    const kept = await readTextIfExists(join(workspace, rel));
    if (kept === undefined) continue;
    // One WE generated is regenerated by this very run under --force, so checking the stale content on disk would
    // gate a deploy on a file about to be replaced.
    const keptIsOurs = isGeneratedDockerignore(kept);
    if (force && keptIsOurs) continue;
    const remedy = (lines: string[]): string =>
      keptIsOurs
        ? `Re-run with --force to regenerate it.`
        : `Add ${lines.map((p) => `\`${p}\``).join(" and ")} before deploying (the same lines the generated ${rel} writes).`;
    const excluded = dockerignoreMatcher(kept);
    // Asked as a DIRECTORY (trailing slash), which is what it is.
    if (excluded(`${basename(agentDir)}/`)) {
      const text =
        `your ${rel} (kept) excludes \`${basename(agentDir)}\` — the build context would ship WITHOUT the ` +
        `agent entirely (the deployed box has no persona/config and crash-loops). Remove that rule ` +
        `before deploying.`;
      if (run) return { ok: false, gate: text };
      messages.push({ level: "warn", text });
    }
    // Resolved paths, not spellings: dockerignore patterns are root-anchored (unlike .gitignore), so a bare
    // `.secrets` line does not cover `fastagent/.secrets`.
    const leaks = leakCandidates.filter((p) => !excluded(p));
    if (leaks.length > 0) {
      const text =
        `your ${rel} (kept) does not exclude ${leaks.map((p) => `\`${p}\``).join(", ")} — the build ` +
        `context would BAKE SECRETS INTO THE IMAGE. ${remedy(leaks.map((p) => `/${p}`))}`;
      if (run) return { ok: false, gate: text };
      messages.push({ level: "warn", text });
    }
    if (stateShips && !excluded(`${stateShips}/sessions`)) {
      messages.push({
        level: "warn",
        text: `your ${rel} (kept) does not exclude \`${stateRel}\` — the build machine's sessions/channel state would ship in the image. ${remedy([`/${stateRel}`])}`,
      });
    }
    // Both the agent's own node_modules and the workspace's.
    const unexcludedDeps = depDirs.filter((p) => !excluded(`${p}/.package-lock.json`));
    if (unexcludedDeps.length > 0) {
      messages.push({
        level: "warn",
        text:
          `your ${rel} does not exclude ${unexcludedDeps.map((p) => `\`${p}\``).join(" or ")} — the ` +
          `build machine's deps (native binaries for YOUR OS) would be uploaded and clobber the image's ` +
          `freshly-installed ones. ${remedy(unexcludedDeps.map((p) => `/${p}`))}`,
      });
    }
    if (excluded(".git/HEAD")) {
      messages.push({
        level: "note",
        text:
          `your ${rel} excludes .git — the baked copy ships WITHOUT history/remote, so the agent ` +
          `cannot pull/commit/push it; it must \`git clone\` its repo in the workspace instead (or remove the .git line).`,
      });
    }
  }

  // Write-back mechanics are fastagent's (the policy is the persona's).
  const apt = shipsGit ? [...new Set(["git", ...(config.deploy?.apt ?? [])])] : config.deploy?.apt;
  const container: ContainerInput = {
    releaseId: randomUUID(),
    agentPrefix,
    machineryPaths,
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt,
    ...(model.envValue !== undefined ? { modelSpec: model.envValue } : {}),
    shipsGit,
  };
  const port = config.http?.port ?? 8787;
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
    if (run) return { ok: false, gate: issue };
    messages.push({ level: "warn", text: issue });
  }
  const declaredSecrets: DeclaredSecret[] = [
    ...allSecrets(resolvedTools.toolSecrets),
    ...allSecrets(loadedRoutines.secrets),
    ...allSecrets(inspected.secrets),
  ];
  // What a KEPT hand-written Dockerfile drops. `deploy.apt` is the obvious one; the resolved model is the one that
  // looks safe and is not: the manifest is always written, but only the generated Dockerfile sets
  // FASTAGENT_RELEASE_FILE, and without it `prepareStartWorkspace` never reads the manifest — so a model that lives
  // ONLY in the value file would be reported here and absent on the box.
  // NOT conditioned on `!force`: `writeArtifacts` refuses a file it did not generate whatever the flag says, so a
  // hand-written Dockerfile survives `--force` and drops exactly the same things. Short-circuiting here let
  // `--run --force` ship the crash-loop this gate exists to stop.
  const dockerfileHome = join(agentDir, "Dockerfile");
  const dockerfileText = (await exists(dockerfileHome)) ? await readFile(dockerfileHome, "utf8") : undefined;
  if (dockerfileText !== undefined && !isGeneratedDockerfile(dockerfileText)) {
    if (config.deploy?.apt?.length) {
      messages.push({
        level: "warn",
        text:
          `kept your hand-written Dockerfile — deploy.apt (${config.deploy.apt.join(", ")}) is ` +
          `NOT applied; install those packages in your Dockerfile.`,
      });
    }
    // The INSTRUCTION is the question, not the file's authorship: `prepareStartWorkspace` returns early without
    // FASTAGENT_RELEASE_FILE, so a Dockerfile that sets it reads the manifest whoever wrote it. This gates rather
    // than warns because it is about FastAgent's OWN delivery arriving — the model would be reported here and
    // missing on the box.
    // Anywhere in an `ENV` instruction, not just first: `ENV A=1 FASTAGENT_RELEASE_FILE=/app/x` is ordinary
    // Dockerfile style and hard-refusing it would be a false gate. A backslash continuation still reads as absent
    // (covering it means joining lines first) — the remaining over-strict edge.
    if (model.envValue !== undefined && !/^\s*ENV\s[^\n]*\bFASTAGENT_RELEASE_FILE[=\s]/m.test(dockerfileText)) {
      const issue =
        `your Dockerfile does not set FASTAGENT_RELEASE_FILE, and the model comes from ${valueFile} — it travels ` +
        `in the release manifest, which is only read when that ENV points at it. Add it (see a generated ` +
        `Dockerfile), or set \`model\` in fastagent.config.ts so it ships in the config instead.`;
      if (run) return { ok: false, gate: issue };
      messages.push({ level: "warn", text: issue });
    }
  }

  return {
    ok: true,
    messages,
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
