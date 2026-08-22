/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE
 * the target branch (Docker / Fly / Railway). Model-travel gate, channel discovery, model-auth probe, the
 * container facts + their warnings, and the hand-written-Dockerfile apt warning are identical on every
 * host — so they live here, out of the CLI dispatcher, testable in isolation (call it against a temp dir
 * and assert the gate / messages / facts). The CLI stays thin: run this, print the messages, branch by host.
 *
 * It returns messages rather than printing them (the CLI owns stderr) and a `{ ok }` outcome mirroring
 * the run modules' {@link import("./fly/run.ts").FlyRunOutcome}: a model that won't travel is a GATE the
 * CLI stops on, distinct from the advisory warnings/notes it prints and proceeds past.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import { classifyBind } from "../bind.ts";
import type { FastagentConfig } from "../engines/pi/config.ts";
import { resolveAuthPath } from "../engines/pi/config.ts";
import { type ResolvedPlacement, resolveSecretsDir, resolveStateRoot } from "../paths.ts";
import { inspectChannels } from "../engines/pi/channel.ts";
import { discoverScheduleFiles } from "../schedule/discover.ts";
import { createPiModelRuntime, modelCredentialCarry, probeAuthSource } from "../engines/pi/models.ts";
import { CHANNEL_KINDS, type ChannelKind } from "../scaffold/add-channel.ts";
import { exists } from "../paths.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile, isGeneratedDockerignore } from "./container.ts";
import { isEnvKey } from "./secrets.ts";

/** A stderr line the CLI prints (`[fastagent] warn: …` / `[fastagent] note: …`). Host-neutral advisories. */
interface DeployMessage {
  level: "warn" | "note";
  text: string;
}

/** The resolved facts every host plan needs (the container shape, channels, model auth, ports/secrets). */
interface DeployFacts {
  messages: DeployMessage[];
  channels: ChannelKind[];
  /** Every structurally detected HTTP-route channel basename, including custom channels. */
  routeChannels: string[];
  /** Every structurally detected long-connection channel basename, including custom channels. */
  longConnectionChannels: string[];
  /** Whether the agent has TIME triggers — `schedules/` files or `selfSchedule` (the wake tool). Cron/wake
   *  has no external wake-up, so the deployment must keep one machine running: the fly plan forces
   *  `min_machines_running=1`, the railway runbook forbids App Sleeping. */
  hasTimeTriggers: boolean;
  /** What satisfies model auth locally — an env-var name, an OAuth/stored label, or undefined. Drives the
   *  runbook's secret guidance and `--run`'s credential carry. For a models.json endpoint keyed from the
   *  environment this is the VARIABLE NAME (see {@link modelCredentialCarry}), not the display label, so
   *  the value carries like any provider key. */
  modelAuth: string | undefined;
  /** The definition itself carries the model key (a models.json literal `apiKey`, or a `!command` run on
   *  the host), so there is nothing for `--run` to carry AND nothing to gate: `fastagent login` cannot
   *  serve a custom provider, so gating on it would strand a correctly configured agent. */
  modelKeyInDefinition: boolean;
  /** The project-level auth file `--run` reads to carry the credential (probed with the same path). */
  authPath: string;
  /** Container facts shared by the plan and the generated Dockerfile — ONE source, so they can't drift. */
  container: ContainerInput;
  port: number;
  extraSecrets: string[];
}

/** Done (facts for the host branch), or a hard gate the CLI stops on (a model that won't reach the box). */
export type DeployPreflight = { ok: false; gate: string } | ({ ok: true } & DeployFacts);

/**
 * "Would docker's packer drop this path?" — built from a `.dockerignore`'s text via the `ignore`
 * matcher (the same library the workspace ignore files use), so `!` negation and last-match-wins are
 * the library's problem, not ours. Anchoring is normalized: dockerignore patterns are root-anchored
 * while .gitignore's match at any depth, so a bare `foo` becomes `/foo` — without that, a root-only
 * `.secrets` line would read as covering `fastagent/.secrets` and hand back a false all-clear on the
 * exact check that guards credentials.
 *
 * Known dialect gap: `ignore` keeps git's rule that a path under an EXCLUDED directory cannot be
 * re-included, which docker does not have — so an allowlist file (`*` + `!fastagent` + `!fastagent/**`)
 * can read as excluding a path docker would ship. The callers below absorb that: the drop-the-agent
 * gate requires the agent DIRECTORY itself to read as excluded too, which an allowlist re-includes.
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

/**
 * Run the host-neutral pre-flight. Throws on a real fault (an unreadable channels/ dir, a throwing
 * provider) — the CLI wraps the call in its `failStartup` so the fault surfaces and exits, never silently.
 */
export async function preflightDeploy(input: {
  /** The resolved placement. `agentDir` is where channels/schedules are discovered and where the
   *  container facts (package.json/lockfile) are read — the AGENT's manifest drives the image's install
   *  step, never the workspace's (whose manifest belongs to its own deploy); `workspace` is the build
   *  context (the whole tree is baked). One value, because one derives from the other: two loose
   *  strings could be handed in disagreeing, and nothing would notice. */
  placement: ResolvedPlacement;
  config: FastagentConfig;
  modelSpec: string | undefined;
  /** `--run` fully deploys, so a model that won't travel is a GATE (a known crash-loop); else it warns. */
  run: boolean;
  /** `--force` regenerates artifacts, so the kept-hand-written-Dockerfile apt warning does not apply. */
  force: boolean;
  /** The target delivers cron slots from an external clock and holds no resident process (AgentCore):
   *  resident-host keep-alive notes do not apply; the host branch owns its capability gates. */
  externalClock?: boolean;
  /** The raw `--auth-path` flag; the chain (flag > FASTAGENT_AUTH_PATH > `<agentDir>/.secrets/auth.json`)
   *  is resolved HERE via {@link resolveAuthPath} — the one owner, same as every serving command. */
  authPathFlag: string | undefined;
}): Promise<DeployPreflight> {
  const {
    placement: { agentDir, workspace },
    config,
    modelSpec,
    run,
    force,
    externalClock,
    authPathFlag,
  } = input;
  // The ONE derived placement fact every host plan needs: where the agent's files sit relative to the
  // build context (the workspace). Nested → "fastagent/"; flat → "" (the agent IS the workspace root).
  const nested = agentDir !== workspace;
  const agentPrefix = nested ? `${basename(agentDir)}/` : "";
  const messages: DeployMessage[] = [];

  // The deployed box resolves the model from fastagent.config.ts ONLY (in the image); a model set via
  // env/flag/.env doesn't travel. `--run` would ship a known crash-loop — hard gate; generate-only warns.
  const modelIssue = modelTravelIssue(config.model, modelSpec);
  if (modelIssue) {
    if (run) return { ok: false, gate: modelIssue };
    messages.push({ level: "warn", text: modelIssue });
  }

  // The control plane on a deployed box: `start` honors `sessionControl: true`, so `/control/*`
  // (steer/abort/set_model) rides the PUBLIC host URL — protected only by a per-boot bearer token
  // minted INSIDE the container (`<stateRoot>/control.json`), which external consumers cannot read.
  // Publicly reachable yet unusable is the worst of both; the tunnel path warns loudly and deploy
  // must not be the silent second way to break the loopback trust story.
  if (config.sessionControl === true) {
    messages.push({
      level: "warn",
      text:
        `sessionControl: true — the deployed box serves /control/* (steer/abort/set_model) at its public URL, ` +
        `protected only by a per-boot token written inside the container. Read the TOKEN from ` +
        `<stateRoot>/control.json on the box (its url field is container-loopback — pair the token with the ` +
        `public host URL: attach --url <public-url> --token …), or front the endpoint with real auth (design §14)`,
    });
  }

  // Known channel kinds only — a custom channel's secrets/webhook are unknown to us; note and let the
  // author wire them.
  const inspected = await inspectChannels(agentDir);
  if (inspected.failures.length > 0) {
    throw new Error(
      `cannot inspect channel modules: ${inspected.failures.map((failure) => `${failure.label}: ${failure.message}`).join("; ")}`,
    );
  }
  const discovered = inspected.channels;
  const channels = discovered.filter((c): c is ChannelKind => (CHANNEL_KINDS as string[]).includes(c));
  const routeChannels = inspected.routeChannels;
  const longConnectionChannels = inspected.longConnectionChannels;
  for (const c of discovered) {
    if (channels.includes(c as ChannelKind)) continue;
    messages.push({
      level: "note",
      text: longConnectionChannels.includes(c)
        ? `long-connection channel "${c}" is custom — configure its secrets yourself; generated deploy plans keep the process running and skip webhook registration`
        : `route channel "${c}" is custom — configure its secrets and webhook yourself`,
    });
  }

  // Time triggers (static schedules or self-scheduling) need a machine kept running — unlike a webhook,
  // nothing external wakes a scale-to-zero box for a cron instant or a wake-up. The note is CONDITIONAL
  // ("the generated plan…"): in KEEP mode an existing fly.toml is not rewritten — the CLI warns separately
  // when a kept fly.toml still scales to zero.
  const hasTimeTriggers = (await discoverScheduleFiles(agentDir)).length > 0 || !!config.selfSchedule;
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

  // Probe auth from the SAME project-level file the opener/login use — not the global default, which would
  // miss a `fastagent login` credential and falsely report "none configured". Through the AGENT's model
  // surface too (its models.json travels into the image), so a custom endpoint is not read as an unknown
  // provider — this probe feeds the gate that decides whether `--run` may proceed.
  const authPath = resolveAuthPath(agentDir, authPathFlag);
  const models = await createPiModelRuntime({ agentDir, authPath });
  let modelAuth = modelSpec ? await probeAuthSource(models, modelSpec) : undefined;
  let modelKeyInDefinition = false;
  // probeAuthSource answers "is it authenticated here", which is not the deploy question ("how does the
  // credential REACH the host"). It reports every models.json endpoint as "configured API key" — not an
  // env-var name — so without this the gate below sees no credential and stops the deploy with two
  // remedies that are both wrong for such an agent: `fastagent login` cannot serve a custom provider,
  // and the key is already in the environment.
  if (modelSpec && !isEnvKey(modelAuth)) {
    const carry = modelCredentialCarry(models, modelSpec);
    if (carry.envVar) modelAuth = carry.envVar;
    else modelKeyInDefinition = carry.inDefinition;
  }

  // Container facts (shared by every host) + the warnings that follow. The facts describe the AGENT —
  // its package.json/runtime/lockfile drive the image's install step — never the workspace's (the bake
  // ships the whole tree, but the workspace's own manifest belongs to its own deploy).
  const hasPackageJson = await exists(join(agentDir, "package.json"));
  const pkg = await readPackageJson(agentDir);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(agentDir, pkg);
  const install = runtime === "bun" ? "bun install" : "npm install";
  const runner = runtime === "bun" ? "bun run fastagent" : "./node_modules/.bin/fastagent";
  const hasOtherLock =
    runtime === "node" &&
    ((await exists(join(agentDir, "pnpm-lock.yaml"))) || (await exists(join(agentDir, "yarn.lock"))));
  // Does the baked workspace ship a `.git`? ONE fact driving both the image's git install (below)
  // and the plans' runbook wording — the write-back loop needs the history AND the binary together.
  const shipsGit = await exists(join(workspace, ".git"));
  // After the facts: the deps sentence must match the agent's actual shape (a markdown-only agent has
  // no package.json and installs nothing — the note must not point at a file that doesn't exist).
  const deps = hasPackageJson
    ? `only the agent's deps (${agentPrefix}package.json) are installed${
        nested ? " — the workspace's own deps are the agent's runtime concern" : ""
      }`
    : `the agent has no package.json, so no deps are installed (the pinned global CLI serves the directory)`;
  const durability = shipsGit
    ? `Un-pushed changes on the box do not survive a redeploy; freshness and write-back run through git, ` +
      `driven by the agent itself (persona owns the policy; GH_TOKEN etc. go in config.deploy.secrets)`
    : `no .git here, so no history ships and the image does not install git — changes on the box are ` +
      `ephemeral and do not survive a redeploy`;
  messages.push({
    level: "note",
    text:
      `the whole directory is baked as the agent's workspace (WYSIWYG — what you see is what ships, ` +
      `git or not, clean or not); ${deps}. ${durability}.`,
  });
  // A code agent with no lockfile builds via a non-frozen install (ranges resolve at build time) — not
  // reproducible. A pnpm/yarn user gets an accurate message (their lockfile is ignored by the npm Dockerfile).
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
  // The code-path Dockerfile runs `${runner}` — the agent's OWN local dependency, never the
  // registry — so a package.json missing it means the container fails at start (no bin to run).
  if (hasPackageJson && !("@fastagent-sh/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies })) {
    messages.push({
      level: "warn",
      text:
        `package.json does not list @fastagent-sh/fastagent — the image's \`${runner}\` has no local bin to run, ` +
        `so the container fails at start. Add it to dependencies and re-run \`${install}\`.`,
    });
  }
  // A KEPT workspace-root .dockerignore silently replaces the generated one's protections — so ASK IT
  // about the exact paths that matter (the generic "kept" line suggests --force, which never clobbers
  // the workspace's own file). Two are GATES under --run, same discipline as the model-travel gate:
  // dropping the agent dir ships a context with no persona/config (the box crash-loops), and an
  // unexcluded secrets path BAKES CREDENTIALS INTO THE IMAGE. The other two are advisory: the build
  // machine's node_modules (native binaries for YOUR OS) clobbering the image's, and an excluded .git
  // killing the agent's pull/push loop (a legitimate slimming choice). Not force-gated — the file is
  // kept even under --force.
  // Which paths INSIDE the build context hold secrets — resolved, then made workspace-relative (the
  // context root). An external secrets dir (a mounted volume) is outside the context: nothing to check
  // and nothing to exclude. Also fed to the generated .dockerignore, so a custom in-tree dir is
  // excluded by PATH even though its name is not `.secrets`.
  const inContext = (p: string): string | undefined => {
    const rel = relative(workspace, p);
    return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
  };
  // The secrets DIR is the unit of RESPONSIBILITY, but never the unit of the leak QUESTION below: the
  // generated ignore excludes the dir's CONTENTS (`**/.secrets/**`) so its two value-free tracked
  // scaffolds can be re-included, and a directory-level question reads that correct file as "not
  // excluded" — the generator's own default output gated its own deploy (field-hit: a fresh
  // kit-layout workspace without --force; --force skips checking our own file, which is why the
  // combination stayed invisible). What leaks is a FILE, so files are what the gate asks about — see
  // secretDirFiles below, which enumerates what is actually inside (an atomic-write temp beside
  // auth.json, a second key file, an editor backup of `.env`: the dir-as-unit worry, covered per
  // file). The auth path adds an entry only when an override puts it OUTSIDE that dir. An external
  // secrets dir (the deployed posture: a mounted volume) is outside the context — nothing to check,
  // nothing to exclude.
  const secretsRel = inContext(resolveSecretsDir(agentDir));
  const authRel = inContext(authPath);
  const authElsewhere = authRel !== undefined && (secretsRel === undefined || !authRel.startsWith(`${secretsRel}/`));
  const secretPaths = [...(secretsRel ? [secretsRel] : []), ...(authElsewhere ? [authRel] : [])];
  // ONE rule for every checked path: a file that is not there cannot be baked, so gating on it would
  // be a refusal about a spelling rather than about what would ship (an agent that has never run
  // `login` has no auth.json). The generated .dockerignore still excludes them unconditionally —
  // cheap, and correct the moment they appear.
  const present = async (rels: string[]): Promise<string[]> => {
    const found: string[] = [];
    for (const rel of rels) if (await exists(join(workspace, rel))) found.push(rel);
    return found;
  };
  // State gets the same treatment (a custom in-tree FASTAGENT_STATE_DIR is invisible to the
  // name-based `**/.state`), at warn level: shipping stale sessions is waste, not a credential leak.
  const stateRel = inContext(resolveStateRoot(agentDir));
  // Existence gates the WARNING, never the generated exclude (same split as secretPaths vs
  // leakCandidates): an agent that has never run has no `.state/`, so telling its author a kept ignore
  // file fails to exclude one is a remark about a spelling — while the file we generate must still carry
  // the line, since it is written once and correct the moment the directory appears.
  const stateShips = stateRel !== undefined && (await exists(join(workspace, stateRel))) ? stateRel : undefined;
  // The `.env` family at the two levels fastagent is RESPONSIBLE for: the agent dir and the workspace
  // root. Asking only about a root-level `.env` missed both halves that matter — an `<agent>/.env`, the
  // file habit puts there (env.ts warns about it by name), and the `.env.local` / `.env.production`
  // spellings. DISCOVERED rather than spelled, so the existing rule still holds: only a file that is
  // there can be baked, so only it is gated.
  //
  // Deliberately NOT the recursive `**/.env` the generated file carries: walking a whole monorepo for
  // credential files is a secret scanner, not a placement pre-flight, and a bounded walk would be a
  // heuristic pretending to be a guarantee. The division of responsibility is the honest one — the file
  // WE generate covers every level; an author who keeps their own owns its coverage of their own tree,
  // and this gate speaks only for the paths fastagent itself puts credentials in.
  const dotEnvFiles = async (relDir: string): Promise<string[]> => {
    const names = await readdir(join(workspace, relDir || ".")).catch(() => [] as string[]);
    // POSIX separators, like every other context-relative path here (`inContext`): these strings are
    // matched against dockerignore patterns, and a Windows `fastagent\.env` would match none of them —
    // silently turning the one check whose failure mode is "credentials in a published image" into a
    // no-op.
    return names
      .filter((n) => (n === ".env" || n.startsWith(".env.")) && n !== ".env.example")
      .map((n) => join(relDir, n).split(sep).join("/"));
  };
  const envFiles = (await Promise.all([...new Set(["", agentPrefix])].map(dotEnvFiles))).flat();
  // Everything ACTUALLY inside the secrets dir, minus the two tracked scaffolds the image ships on
  // purpose (they carry no values; the generated ignore re-includes them by name). Existence is the
  // enumeration itself — readdir lists exactly what could be baked — and a hand-written ignore that
  // misses the dir now gates NAMING the leaking file, a better diagnostic than pointing at a
  // directory. Recurses: a subdirectory inside .secrets is unusual but its files leak all the same.
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

  // BOTH ignore files deploy emits get the same interrogation. The workspace-root one is what
  // flyctl/railway's packers read; the per-Dockerfile one is what BuildKit PREFERS for a plain
  // `docker build` (so it is the file that actually decides `deploy docker`). Checking only the root one
  // left the credential gate not covering the path it was written for.
  for (const rel of [".dockerignore", `${agentPrefix}Dockerfile.dockerignore`]) {
    const kept = await readFile(join(workspace, rel), "utf8").catch(() => undefined);
    if (kept === undefined) continue;
    // One WE generated is regenerated by this very run under --force, so checking the stale content on
    // disk would gate a deploy on a file about to be replaced. Ours + --force: skip. Ours WITHOUT --force
    // is still checked (it is what would ship), but the remedy differs: hand-adding lines to fastagent's
    // own output is not the fix — regenerating it is.
    const keptIsOurs = isGeneratedDockerignore(kept);
    if (force && keptIsOurs) continue;
    const remedy = (lines: string[]): string =>
      keptIsOurs
        ? `Re-run with --force to regenerate it.`
        : `Add ${lines.map((p) => `\`${p}\``).join(" and ")} before deploying (the same lines the generated ${rel} writes).`;
    const excluded = dockerignoreMatcher(kept);
    // Asked as a DIRECTORY (trailing slash), which is what it is. A bare-name test answers `false` for
    // the `fastagent/` spelling — a directory-only pattern, and the one a hand-written ignore file is
    // most likely to carry — so the agent would be dropped from the context with no warning at all. The
    // pairing this replaced (the directory AND a file inside it) was dead weight rather than a
    // safeguard: git's rule that a file under an excluded directory cannot be re-included is
    // implemented by the matcher, so `excluded(dir)` already implies `excluded(dir/persona.md)` and the
    // second test could never change the answer. What it was aimed at — an allowlist (`*` +
    // `!fastagent` + `!fastagent/**`) that re-includes the agent — is handled by the first test alone,
    // which reads `false` there, as it should.
    if (nested && excluded(`${basename(agentDir)}/`)) {
      const text =
        `your ${rel} (kept) excludes \`${basename(agentDir)}\` — the build context would ship WITHOUT the ` +
        `agent entirely (the deployed box has no persona/config and crash-loops). Remove that rule ` +
        `before deploying.`;
      if (run) return { ok: false, gate: text };
      messages.push({ level: "warn", text });
    }
    // Resolved paths, not spellings: dockerignore patterns are root-anchored (unlike .gitignore), so a
    // bare `.secrets` line does not cover `fastagent/.secrets` — and FASTAGENT_SECRETS_DIR /
    // FASTAGENT_AUTH_PATH can put credentials anywhere in the baked tree, where the name-based excludes
    // never reach. This is the one check whose failure mode is "credentials in a published image".
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
    // Both the agent's own node_modules and the workspace's: either would upload the build machine's
    // deps (native binaries for YOUR OS) and clobber the image's freshly-installed ones. Named by the
    // PATHS actually found unexcluded, like every other check here — not by a rule's spelling.
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

  // Write-back mechanics are fastagent's (the policy is the persona's): the image carries the git
  // BINARY iff the baked workspace ships a `.git` (history without the binary is a
  // dead loop; the binary without history is dead weight). A non-git workspace that still needs git
  // (the agent clones repos as its job) declares config.deploy.apt: ["git"] explicitly. Merged with
  // (never duplicating) config.deploy.apt.
  const apt = shipsGit ? [...new Set(["git", ...(config.deploy?.apt ?? [])])] : config.deploy?.apt;
  const container: ContainerInput = {
    agentPrefix,
    machineryPaths,
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt,
    shipsGit,
  };
  const port = config.http?.port ?? 8787;
  // What will the CONTAINER bind? Two things can answer, and the CLI flag wins over config, so the
  // question has to be asked in that order — not as two independent checks that can each be right
  // about their own input and wrong about the container.
  //
  // A generated Dockerfile passes `--bind 0.0.0.0`, which overrides whatever `http.host` travelled in.
  // A kept one might not, and then config is what binds.
  const dockerfileHome = join(agentDir, "Dockerfile");
  const keptDockerfile = !force && (await exists(dockerfileHome)) ? await readFile(dockerfileHome, "utf8") : undefined;
  const generated = keptDockerfile !== undefined && isGeneratedDockerfile(keptDockerfile);
  // What a generated Dockerfile binds is knowable: we wrote its CMD, it is one line, and it is the
  // only CMD in the file. Read THAT line — not the file, where a `--bind 0.0.0.0` sitting in a
  // comment would answer for a CMD that has none.
  //
  // What a hand-written one binds is not knowable here, and no amount of pattern-matching makes it
  // so: multi-stage builds, ENTRYPOINT/CMD interaction, line continuations, an unused ENV. Guessing
  // toward silence is the dangerous direction — it waves through exactly the container this exists
  // to catch — so an unknown stays unknown and is reported as one.
  const generatedCmd = generated ? keptDockerfile?.split("\n").find((line) => line.startsWith("CMD")) : undefined;
  const generatedCmdBindsWildcard =
    generatedCmd !== undefined && /--bind["',\s]+(0\.0\.0\.0|::)["',\s]/.test(generatedCmd);

  const configBind = classifyBind(config.http?.host);
  // Unset and an explicit "0.0.0.0" both classify as wildcard, and only the explicit one travels into
  // the image and binds there. classifyBind must not learn that difference — it answers about a
  // value, and unset is the absence of one — so it is made here, where the question is a container.
  const configStatesWildcard = config.http?.host !== undefined && configBind === "wildcard";
  // `http.host` only decides the bind when nothing on the command line does. When the container
  // passes the wildcard, a laptop-shaped `http.host` travels in and is ignored — gating on it would
  // refuse a container that answers perfectly well.
  if (keptDockerfile !== undefined && !generatedCmdBindsWildcard && configBind !== "wildcard") {
    const issue =
      `fastagent.config.ts sets http.host: "${config.http?.host}", and your Dockerfile does not pass ` +
      `--bind — so in the image ` +
      (configBind === "loopback"
        ? `nothing outside the container can reach the serve (published port, health check, webhooks).`
        : `that address does not exist, so the container fails to bind at start.`) +
      ` Drop it and use \`--bind ${config.http?.host}\` locally instead, or pass --bind 0.0.0.0 in the CMD.`;
    // Same disposition as the model-travel issue: warn when producing artifacts (the operator may be
    // deploying somewhere that fronts the port), gate `--run` — which would otherwise ship a box that
    // answers nothing, or crash-loops on a bind that cannot resolve inside the container.
    if (run) return { ok: false, gate: issue };
    messages.push({ level: "warn", text: issue });
  } else if (generated && !generatedCmdBindsWildcard && !configStatesWildcard) {
    // Ours, so the finding is certain: the CMD we wrote is right there and it has no wildcard bind.
    const issue =
      `your Dockerfile's CMD does not pass \`--bind 0.0.0.0\` — a serve binds 127.0.0.1 unless told ` +
      `otherwise, so the container would answer nothing from outside. Re-generate it with --force, or ` +
      `add the flag.`;
    if (run) return { ok: false, gate: issue };
    messages.push({ level: "warn", text: issue });
  } else if (keptDockerfile !== undefined && !generated) {
    // Not ours: say what was NOT checked. An `http.host: "0.0.0.0"` does not settle it either — a CMD
    // is free to pass `--bind 127.0.0.1` and the flag wins.
    messages.push({
      level: "warn",
      text:
        `check that your Dockerfile's CMD passes \`--bind 0.0.0.0\` — a serve binds 127.0.0.1 unless ` +
        `told otherwise, and a container bound to loopback answers nothing from outside. This is not ` +
        `verified: which CMD a hand-written Dockerfile ends up running is not something deploy reads.`,
    });
  }

  const extraSecrets = config.deploy?.secrets ?? [];
  // deploy.apt only shapes the GENERATED Dockerfile. Warn ONLY when the kept Dockerfile is HAND-WRITTEN
  // (its apt won't include these) — a fastagent-generated one is handled by writeArtifacts. Don't suggest
  // --force here: it would overwrite the user's hand-written file.
  if (config.deploy?.apt?.length && keptDockerfile !== undefined) {
    if (!generated) {
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
    routeChannels,
    longConnectionChannels,
    hasTimeTriggers,
    modelAuth,
    modelKeyInDefinition,
    authPath,
    container,
    port,
    extraSecrets,
  };
}

/**
 * Why the resolved model won't reach the deployed box, or undefined if it will — host-neutral. `fastagent.config.ts`
 * is the model's committed home (config's charter: model / tools / http) and the only source deploy ships:
 * a `--model`/`FASTAGENT_MODEL`/`.env` value is builder-local and doesn't travel (`.env` is dockerignored),
 * so a model NOT in config crash-loops the box with "missing model". The pre-flight warns (runbook) or gates
 * (`--run`). Single source on purpose — a host env block (fly.toml `[env]`) is NOT advertised as a second home.
 */
export function modelTravelIssue(configModel: string | undefined, modelSpec: string | undefined): string | undefined {
  if (configModel) return undefined;
  return modelSpec
    ? `model "${modelSpec}" is set via --model/FASTAGENT_MODEL, not fastagent.config.ts — it won't reach ` +
        `the deployed box. Add \`model: "${modelSpec}"\` to fastagent.config.ts.`
    : `no model in fastagent.config.ts — the deployed box can't resolve one. Add \`model: "provider/id"\`.`;
}
