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
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { FastagentConfig } from "../engines/pi/config.ts";
import { resolveAuthPath } from "../engines/pi/config.ts";
import { discoverChannelFiles } from "../engines/pi/channel.ts";
import { discoverScheduleFiles } from "../schedule/discover.ts";
import { createPiModels, probeAuthSource } from "../engines/pi/models.ts";
import { CHANNEL_KINDS, type ChannelKind } from "../scaffold/add-channel.ts";
import { exists } from "../scaffold/init.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";

/** A stderr line the CLI prints (`[fastagent] warn: …` / `[fastagent] note: …`). Host-neutral advisories. */
export interface DeployMessage {
  level: "warn" | "note";
  text: string;
}

/** The resolved facts every host plan needs (the container shape, channels, model auth, ports/secrets). */
export interface DeployFacts {
  messages: DeployMessage[];
  channels: ChannelKind[];
  /** Whether the agent has TIME triggers — `schedules/` files or `selfSchedule` (the wake tool). Cron/wake
   *  has no external wake-up, so the deployment must keep one machine running: the fly plan forces
   *  `min_machines_running=1`, the railway runbook forbids App Sleeping. */
  hasTimeTriggers: boolean;
  /** What satisfies model auth locally ({@link probeAuthSource}) — an env-var name, an OAuth/stored label,
   *  or undefined. Drives the runbook's secret guidance and `--run`'s credential carry. */
  modelAuth: string | undefined;
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
 * Run the host-neutral pre-flight. Throws on a real fault (an unreadable channels/ dir, a throwing
 * provider) — the CLI wraps the call in its `failStartup` so the fault surfaces and exits, never silently.
 */
export async function preflightDeploy(input: {
  target: string;
  /** The agent-definition dir (config.agentDir resolved against target; = target when unset) — where
   *  channels are discovered. Container facts (package.json/lockfile) still read `target`, the run root. */
  agentDir: string;
  config: FastagentConfig;
  modelSpec: string | undefined;
  /** `--run` fully deploys, so a model that won't travel is a GATE (a known crash-loop); else it warns. */
  run: boolean;
  /** `--force` regenerates artifacts, so the kept-hand-written-Dockerfile apt warning does not apply. */
  force: boolean;
  /** The raw `--auth-path` flag; the chain (flag > FASTAGENT_AUTH_PATH > `<state root>/auth.json`)
   *  is resolved HERE via {@link resolveAuthPath} — the one owner, same as every serving command. */
  authPathFlag: string | undefined;
}): Promise<DeployPreflight> {
  const { target, agentDir, config, modelSpec, run, force, authPathFlag } = input;
  const messages: DeployMessage[] = [];

  // The deployed box resolves the model from fastagent.config.ts ONLY (in the image); a model set via
  // env/flag/.env doesn't travel. `--run` would ship a known crash-loop — hard gate; generate-only warns.
  const modelIssue = modelTravelIssue(config.model, modelSpec);
  if (modelIssue) {
    if (run) return { ok: false, gate: modelIssue };
    messages.push({ level: "warn", text: modelIssue });
  }

  // Known channel kinds only — a custom channel's secrets/webhook are unknown to us; note and let the
  // author wire them.
  const discovered = await discoverChannelFiles(agentDir);
  const channels = discovered.filter((c): c is ChannelKind => (CHANNEL_KINDS as string[]).includes(c));
  for (const c of discovered) {
    if (!channels.includes(c as ChannelKind)) {
      messages.push({ level: "note", text: `channel "${c}" is custom — set its secrets and webhook yourself` });
    }
  }

  // Time triggers (static schedules or self-scheduling) need a machine kept running — unlike a webhook,
  // nothing external wakes a scale-to-zero box for a cron instant or a wake-up. The note is CONDITIONAL
  // ("the generated plan…"): in KEEP mode an existing fly.toml is not rewritten — the CLI warns separately
  // when a kept fly.toml still scales to zero.
  const hasTimeTriggers = (await discoverScheduleFiles(agentDir)).length > 0 || !!config.selfSchedule;
  if (hasTimeTriggers) {
    messages.push({
      level: "note",
      text:
        `schedules/self-scheduling present — a GENERATED plan keeps one machine running (cron/wake has ` +
        `no external wake-up; scale-to-zero would sleep through them).`,
    });
  }

  // Probe auth from the SAME project-level file the opener/login use — not the global default, which would
  // miss a `fastagent login` credential and falsely report "none configured".
  const authPath = resolveAuthPath(target, authPathFlag);
  const modelAuth = modelSpec ? await probeAuthSource(createPiModels({ authPath }), modelSpec) : undefined;

  // Container facts (shared by every host) + the warnings that follow. Repo-as-workspace layout
  // (agentDir ≠ target): the facts describe the KIT — its package.json/runtime/lockfile drive the
  // image's install step — never the host repo's (whose manifest belongs to the host's own deploy).
  // POSIX-normalized: kitDir lands verbatim in Dockerfile COPY/CMD lines and fly/railway commands,
  // which all require forward slashes (a Windows `relative()` would emit backslashes).
  const kitDir = agentDir === target ? undefined : relative(target, agentDir).split(sep).join("/");
  const factsDir = kitDir ? agentDir : target;
  if (kitDir && run) {
    // The repo-as-workspace deployment shape remains experimental for every target. Generation +
    // runbook are supported; automated runners stay gated until an explicit end-to-end smoke validates
    // context packing, ignore rules, installed deps, state, and write-back for this layout.
    return {
      ok: false,
      gate: `--run is not yet supported for the agentDir layout — run the same deploy without --run and follow the printed runbook`,
    };
  }

  const hasPackageJson = await exists(join(factsDir, "package.json"));
  const pkg = await readPackageJson(factsDir);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(factsDir, pkg);
  const install = runtime === "bun" ? "bun install" : "npm install";
  const runner = runtime === "bun" ? "bun run fastagent" : "./node_modules/.bin/fastagent";
  const hasOtherLock =
    runtime === "node" &&
    ((await exists(join(factsDir, "pnpm-lock.yaml"))) || (await exists(join(factsDir, "yarn.lock"))));
  if (kitDir) {
    // After the facts: the deps sentence must match the kit's actual shape (a markdown-only kit has no
    // package.json and installs nothing — the note must not point at a file that doesn't exist).
    const deps = hasPackageJson
      ? `only the kit's deps (${kitDir}/package.json) are installed — the host repo's own deps are the agent's runtime concern`
      : `the kit has no package.json, so no deps are installed (the pinned global CLI serves the repo)`;
    messages.push({
      level: "note",
      text:
        `repo-as-workspace image (EXPERIMENTAL — not yet verified end-to-end on a real host): the whole ` +
        `repo is baked as the agent's cwd; ${deps}. Un-pushed changes on the box do not survive a redeploy ` +
        `(the image is a snapshot); write-back goes through git (persona owns the policy; GH_TOKEN etc. go ` +
        `in config.deploy.secrets — see the runbook's caveat on .git surviving the host's upload).`,
    });
  }
  // A code workspace with no lockfile builds via a non-frozen install (ranges resolve at build time) — not
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
  // The code-path Dockerfile runs `${runner}` — the workspace's OWN local dependency, never the
  // registry — so a package.json missing it means the container fails at start (no bin to run).
  if (hasPackageJson && !("@fastagent-sh/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies })) {
    messages.push({
      level: "warn",
      text:
        `package.json does not list @fastagent-sh/fastagent — the image's \`${runner}\` has no local bin to run, ` +
        `so the container fails at start. Add it to dependencies and re-run \`${install}\`.`,
    });
  }
  // A kept host root .dockerignore silently replaces KIT_DOCKERIGNORE's two protections — read it and
  // warn SPECIFICALLY (the generic "kept" line suggests --force, which would clobber the host's file):
  // (a) a .git exclude kills the baked write-back (the runtime-clone fallback applies); (b) without a
  // recursive **/node_modules the build machine's kit deps (native binaries) clobber the image's.
  // Not force-gated: the host's root .dockerignore is kept even under --force (never ours to clobber),
  // so these warnings apply regardless.
  if (kitDir && (await exists(join(target, ".dockerignore")))) {
    const lines = (await readFile(join(target, ".dockerignore"), "utf8")).split("\n").map((l) => l.trim());
    if (lines.some((l) => l === ".git" || l === "/.git" || l === ".git/" || l === "**/.git")) {
      messages.push({
        level: "warn",
        text:
          `your .dockerignore excludes .git — the baked repo ships WITHOUT history/remote, so the agent ` +
          `cannot commit/push the baked copy; it must \`git clone\` its repo in the workspace instead ` +
          `(or remove the .git line).`,
      });
    }
    if (!lines.some((l) => l === "**/node_modules" || l === "**/node_modules/")) {
      messages.push({
        level: "warn",
        text:
          `your .dockerignore lacks \`**/node_modules\` — the build machine's ${kitDir}/node_modules ` +
          `(native binaries for YOUR OS) would be uploaded and clobber the image's freshly-installed ones. ` +
          `Add \`**/node_modules\` to it.`,
      });
    }
  }

  // Write-back mechanics are fastagent's (the policy is the persona's): a kit-layout image always
  // carries git, so commit/push can work at all. Merged with (never duplicating) config.deploy.apt.
  const apt = kitDir ? [...new Set(["git", ...(config.deploy?.apt ?? [])])] : config.deploy?.apt;
  const container: ContainerInput = {
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt,
    kitDir,
  };
  const port = config.http?.port ?? 8787;
  // What the agent declared it needs on the box (fastagent.config deploy.secrets) — carried like channel
  // secrets: listed in the runbook, set from the local env under --run, gated if a value is missing.
  const extraSecrets = config.deploy?.secrets ?? [];
  // deploy.apt only shapes the GENERATED Dockerfile. Warn ONLY when the kept Dockerfile is HAND-WRITTEN
  // (its apt won't include these) — a fastagent-generated one is handled by writeArtifacts. Don't suggest
  // --force here: it would overwrite the user's hand-written file.
  const dockerfileHome = kitDir ? join(agentDir, "Dockerfile") : join(target, "Dockerfile");
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

  return { ok: true, messages, channels, hasTimeTriggers, modelAuth, authPath, container, port, extraSecrets };
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
