/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE the target
 * branch (Docker / Fly / Railway).
 */
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import { classifyBind } from "../bind.ts";
import { isModelSpec, isReleaseAgentName } from "./workspace.ts";
import { type FastagentConfig, resolveAuthPath } from "../engines/pi/config.ts";
import { type ResolvedPlacement, resolveSecretsDir, resolveStateRoot, exists, readTextIfExists } from "../paths.ts";
import { type DeclaredChannel, inspectChannels } from "../channels/discover.ts";
import { loadSchedules } from "../schedule/discover.ts";
import { resolveAgentTools } from "../engines/pi/create.ts";
import { type DeclaredSecret, allSecrets } from "../declared-secrets.ts";
import { createPiModelRuntime, modelCredentialCarry, probeAuthSource } from "../engines/pi/models.ts";
import { providerOf } from "../engines/pi/config.ts";
import { AGENT_MODELS_FILE } from "../paths.ts";
import { CHANNEL_KINDS } from "../scaffold/add-channel.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile, isGeneratedDockerignore } from "./container.ts";
import { dotEnvPath, loadEnvValues } from "../env.ts";
import { CONTROL_TOKEN_ENV } from "../channels/control.ts";
import { isEnvKey } from "./secrets.ts";

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
  /** Whether the agent has TIME triggers — `schedules/` files or `selfSchedule` (the wake tool). */
  hasTimeTriggers: boolean;
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
  /** The declared secrets — config `deploy.secrets`, the control token, and every tool/schedule
   *  declaration — carried to the host and listed in the runbook by their declaring file. */
  extraSecrets: DeclaredSecret[];
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
  /** `--force` regenerates artifacts, so the kept-hand-written-Dockerfile apt warning does not apply. */
  force: boolean;
  /** The target delivers cron slots from an external clock and holds no resident process (AgentCore). */
  externalClock?: boolean;
  /**
   * The raw `--auth-path` flag; the chain (flag > FASTAGENT_AUTH_PATH > `<agentDir>/.secrets/auth.json`) is resolved
   * HERE via {@link resolveAuthPath}.
   */
  authPathFlag: string | undefined;
}): Promise<DeployPreflight> {
  const {
    placement: { agentDir, workspace },
    config,
    run,
    force,
    externalClock,
    authPathFlag,
  } = input;
  // The ONE derived placement fact every host plan needs: where the agent's files sit relative to the build context
  // (the workspace).
  if (agentDir === workspace) {
    return {
      ok: false,
      gate: "deploy requires a nested agent directory; point deploy at the workspace containing fastagent/",
    };
  }
  // The release manifest carries this name into the container, where it is joined onto the storage root — so `init`'s
  // "one path segment" is not enough here.
  if (!isReleaseAgentName(basename(agentDir))) {
    return {
      ok: false,
      gate:
        `the agent directory "${basename(agentDir)}" cannot be deployed — a deployed agent directory ` +
        `may use only letters, digits, "-" and "_"; rename it (the fastagent.config.* inside is what ` +
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
      `no model resolves for this deployment — set \`model: "provider/id"\` in fastagent.config.* (it travels ` +
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

  // The control plane on a deployed box: `start` honors `sessionControl: true`, so `/control/*` (steer, stop, rewrite
  // or delete a session) rides the PUBLIC host URL, protected only by the bearer token.
  if (config.sessionControl === true) {
    messages.push({
      level: "warn",
      text:
        `sessionControl: true — the deployed box serves /control/* (steer, stop, rewrite or delete a session) at its public URL, ` +
        `protected only by a bearer token. Set ${CONTROL_TOKEN_ENV} (listed with the other secrets) and give the ` +
        `same value to callers: attach --url <public-url> --token …. Unset, the box mints its own per boot — ` +
        `readable only by shelling in (\`docker compose exec\`/\`fly ssh console\`: <stateRoot>/control.json, whose ` +
        `url field is container-loopback) and replaced on every restart. Front the endpoint with real auth for ` +
        `anything wider (docs/design/session-control.md §14)`,
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
  // A custom channel that used `defineChannel({ secrets })` HAS told us its credentials, and they are
  // carried below with every other declaration — telling its author to configure them by hand would
  // send them to copy a list into deploy.secrets, which is the duplicate list this replaced.
  const declaresSecrets = new Set(
    [...inspected.secrets].flatMap(([owner, declared]) => (declared.length > 0 ? [owner] : [])),
  );
  for (const { name, ingress } of channels) {
    if ((CHANNEL_KINDS as string[]).includes(name)) continue;
    const declares = declaresSecrets.has(name);
    const secretsPart = declares
      ? `its declared secrets travel with the deploy`
      : `configure its secrets yourself (declare them with defineChannel to have deploy carry them)`;
    messages.push({
      level: "note",
      text:
        ingress === "long-connection"
          ? `long-connection channel "${name}" is custom — ${secretsPart}; generated deploy plans keep the process running and skip webhook registration`
          : `route channel "${name}" is custom — ${secretsPart}; configure its webhook yourself`,
    });
  }
  const longConnectionChannels = channels.filter((c) => c.ingress === "long-connection").map((c) => c.name);

  // Time triggers (static schedules or self-scheduling) need a machine kept running.
  // Loaded, not just listed: the same load answers "are there time triggers" AND "what did they declare they need".
  // A file that FAILED to load still counts as a trigger — the author will fix it, and a plan that scaled to zero
  // because a cron was broken on deploy day would sleep through it afterwards.
  const loadedSchedules = await loadSchedules(agentDir);
  const hasTimeTriggers =
    loadedSchedules.schedules.length + loadedSchedules.failures.length > 0 || !!config.selfSchedule;
  if (longConnectionChannels.length > 0 && !externalClock) {
    messages.push({
      level: "note",
      text:
        `long-connection channel present (${longConnectionChannels.join(", ")}) — a GENERATED plan keeps one machine running ` +
        `(an outbound connection cannot wake a scaled-to-zero service).`,
    });
  }
  if (hasTimeTriggers && !externalClock) {
    messages.push({
      level: "note",
      text:
        `schedules/self-scheduling present — a GENERATED plan keeps one machine running (cron/wake has ` +
        `no external wake-up; scale-to-zero would sleep through them).`,
    });
  }

  // Probe auth from the SAME project-level file the opener/login use.
  const authPath = resolveAuthPath(agentDir, authPathFlag);
  const models = await createPiModelRuntime({ agentDir, authPath });
  let modelAuth = modelSpec ? await probeAuthSource(models, modelSpec) : undefined;
  let modelKeyInDefinition = false;
  // probeAuthSource answers "is it authenticated here", which is not the deploy question ("how does the credential
  // REACH the host").
  if (modelSpec && !isEnvKey(modelAuth)) {
    const carry = modelCredentialCarry(models, modelSpec);
    if (carry.envVar) modelAuth = carry.envVar;
    else modelKeyInDefinition = carry.inDefinition;
    if (carry.literalKey) {
      // Same rule the `.dockerignore` check enforces: any configuration that would put a credential into the image
      // gates `--run`. A literal has no legitimate use here — an endpoint that needs no key can omit it, and one
      // that needs a key has two forms that do not ship it.
      const issue =
        `${AGENT_MODELS_FILE} carries a literal apiKey for "${providerOf(modelSpec)}" — that file ships inside the ` +
        `image, where anyone who can pull it reads the layer. Use "$YOUR_ENV_VAR" (deploy carries it like any ` +
        `provider key) or "!command" (it runs on the box and never travels).`;
      if (run) return { ok: false, gate: issue };
      messages.push({ level: "warn", text: issue });
    }
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
  // `http.host` travels in the artifact (config is what deploy ships), and any non-wildcard value that is right on a
  // laptop is wrong in a container.
  const configBind = classifyBind(config.http?.host);
  if (configBind !== "wildcard") {
    const issue =
      `fastagent.config.ts sets http.host: "${config.http?.host}" — it travels into the image, where ` +
      (configBind === "loopback"
        ? `nothing outside the container can reach the serve (published port, health check, webhooks).`
        : `that address does not exist, so the container fails to bind at start.`) +
      ` Drop it and use \`--bind ${config.http?.host}\` locally instead.`;
    // Warn when only producing artifacts (the operator may be deploying somewhere that fronts the port), gate
    // `--run`, where the unreachable bind is a certainty rather than a possibility.
    if (run) return { ok: false, gate: issue };
    messages.push({ level: "warn", text: issue });
  }
  // EVERYTHING the definition declared it needs, from wherever it was declared. `deploy.secrets` is now only the list
  // for what no code declares. Read through the SAME resolver dev/start mount with, so "which tool declarations
  // count" has one answer (config.tools declare too; a shadowed file's declaration is dropped in both places).
  const resolvedTools = await resolveAgentTools(config, agentDir, workspace);
  // A code input we could not READ is a code input whose declarations we cannot carry — and the box
  // WILL read it (its deps are installed there), so its gate fires after the deploy reported success:
  // a crash loop, which is the failure mode this whole mechanism exists to move to build time. Under
  // `--run` that is a gate, like a channel that fails to inspect; generate-only warns, since the
  // operator may be producing artifacts from a machine that never installed the agent's deps.
  for (const failure of [...resolvedTools.toolFailures, ...loadedSchedules.failures]) {
    const issue =
      `${failure.label} failed to load (${failure.message}) — any secrets it declares cannot be carried ` +
      `to the host, so the deployed box would refuse to start`;
    if (run) return { ok: false, gate: issue };
    messages.push({ level: "warn", text: issue });
  }
  const extraSecrets: DeclaredSecret[] = [
    ...(config.deploy?.secrets ?? []).map((name) => ({ name, source: "fastagent.config deploy.secrets" })),
    ...allSecrets(resolvedTools.toolSecrets),
    ...allSecrets(loadedSchedules.secrets),
    // A CUSTOM channel's credentials exist nowhere else: the first-party table can only name the channels fastagent
    // ships, and guessing a custom one's variables is impossible.
    ...allSecrets(inspected.secrets),
  ];
  // The plane's bearer token is the DEPLOYMENT's secret, not the container's.
  if (config.sessionControl === true) {
    extraSecrets.push({ name: CONTROL_TOKEN_ENV, source: "fastagent.config sessionControl" });
  }
  // deploy.apt only shapes the GENERATED Dockerfile. (The resolved model does not: it rides the release manifest,
  // which every host writes unconditionally, so a hand-written Dockerfile changes nothing about it.)
  const dockerfileHome = join(agentDir, "Dockerfile");
  if (config.deploy?.apt?.length && !force && (await exists(dockerfileHome))) {
    if (!isGeneratedDockerfile(await readFile(dockerfileHome, "utf8"))) {
      messages.push({
        level: "warn",
        text:
          `kept your hand-written Dockerfile — deploy.apt (${config.deploy.apt.join(", ")}) is ` +
          `NOT applied; install those packages in your Dockerfile.`,
      });
    }
  }

  return {
    ok: true,
    messages,
    channels,
    hasTimeTriggers,
    values,
    valueFile,
    modelAuth,
    modelKeyInDefinition,
    authPath,
    container,
    port,
    extraSecrets,
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
