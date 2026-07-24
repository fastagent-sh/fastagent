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
import { join } from "node:path";
import type { FastagentConfig } from "../engines/pi/config.ts";
import { STANDALONE_DIR, resolveAuthPath } from "../engines/pi/config.ts";
import { inspectChannels } from "../engines/pi/channel.ts";
import { discoverScheduleFiles } from "../schedule/discover.ts";
import { createPiModels, probeAuthSource } from "../engines/pi/models.ts";
import { CHANNEL_KINDS, type ChannelKind } from "../scaffold/add-channel.ts";
import { exists } from "../scaffold/init.ts";
import { detectRuntime, readPackageJson } from "../runtime.ts";
import { fastagentVersion } from "../version.ts";
import { type ContainerInput, isGeneratedDockerfile } from "./container.ts";

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
  /** The workspace ROOT (resolveWorkspace().root) — channels/schedules are discovered here, and the
   *  container facts (package.json/lockfile) read it: the workspace's manifest drives the image's
   *  install step, never the host repo's (whose manifest belongs to the host's own deploy). */
  root: string;
  /** The workbench (build context; = root when flat, the host tree when standalone). */
  workbench: string;
  standalone: boolean;
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
  const { root, workbench, standalone, config, modelSpec, run, force, authPathFlag } = input;
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
  const inspected = await inspectChannels(root);
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
  const hasTimeTriggers = (await discoverScheduleFiles(root)).length > 0 || !!config.selfSchedule;
  if (longConnectionChannels.length > 0) {
    messages.push({
      level: "note",
      text:
        `long-connection channel present (${longConnectionChannels.join(", ")}) — a GENERATED plan keeps one machine running ` +
        `(an outbound connection cannot wake a scaled-to-zero service).`,
    });
  }
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
  const authPath = resolveAuthPath(root, authPathFlag);
  const modelAuth = modelSpec ? await probeAuthSource(createPiModels({ authPath }), modelSpec) : undefined;

  // Container facts (shared by every host) + the warnings that follow. The facts describe the
  // WORKSPACE — its package.json/runtime/lockfile drive the image's install step — never the host
  // repo's (standalone bakes the whole workbench, but the host's manifest belongs to its own deploy).
  const hasPackageJson = await exists(join(root, "package.json"));
  const pkg = await readPackageJson(root);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(root, pkg);
  const install = runtime === "bun" ? "bun install" : "npm install";
  const runner = runtime === "bun" ? "bun run fastagent" : "./node_modules/.bin/fastagent";
  const hasOtherLock =
    runtime === "node" && ((await exists(join(root, "pnpm-lock.yaml"))) || (await exists(join(root, "yarn.lock"))));
  // Does the baked workbench ship a `.git`? ONE fact driving both the image's git install (below)
  // and the plans' runbook wording — the write-back loop needs the history AND the binary together.
  const shipsGit = await exists(join(workbench, ".git"));
  if (standalone) {
    // After the facts: the deps sentence must match the workspace's actual shape (a markdown-only
    // workspace has no package.json and installs nothing — the note must not point at a file that
    // doesn't exist).
    const deps = hasPackageJson
      ? `only the workspace's deps (.fastagent/package.json) are installed — the host repo's own deps are the agent's runtime concern`
      : `the workspace has no package.json, so no deps are installed (the pinned global CLI serves the directory)`;
    const durability = shipsGit
      ? `Un-pushed changes on the box do not survive a redeploy; freshness and write-back run through git, ` +
        `driven by the agent itself (persona owns the policy; GH_TOKEN etc. go in config.deploy.secrets)`
      : `no .git here, so no history ships and the image does not install git — changes on the box are ` +
        `ephemeral and do not survive a redeploy`;
    messages.push({
      level: "note",
      text:
        `standalone image: the whole directory is baked as the agent's workbench (WYSIWYG — what you see ` +
        `is what ships, git or not, clean or not); ${deps}. ${durability}.`,
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
  // A KEPT workbench-root .dockerignore silently replaces the generated one's protections — read it
  // and check SPECIFICALLY (the generic "kept" line suggests --force, which never clobbers the host's
  // file). The critical ones: (a) a rule matching `.fastagent` on a standalone deploy — the packer
  // would drop the WHOLE workspace from the context (the box boots with no agent and crash-loops);
  // (b) `.secrets`/`.env` excludes — without them the packer BAKES SECRETS INTO THE IMAGE. Both GATE
  // under --run (a full deploy must not push a broken or secret-laden image; same discipline as the
  // model-travel gate) and warn generate-only. (c) a recursive **/node_modules — without it the build
  // machine's deps (native binaries for YOUR OS) clobber the image's (warn); (d) a .git exclude kills
  // the agent's pull/push loop (note-level: a legitimate slimming choice). Not force-gated: kept even
  // under --force. `covers` is a conservative line matcher, not full dockerignore semantics: a `!`
  // negation naming the same form reads as NOT covered (a false warn beats a false all-clear).
  if (await exists(join(workbench, ".dockerignore"))) {
    const lines = (await readFile(join(workbench, ".dockerignore"), "utf8")).split("\n").map((l) => l.trim());
    const matches = (l: string, name: string): boolean =>
      l === name || l === `${name}/` || l === `**/${name}` || l === `**/${name}/` || l === `/${name}`;
    const covers = (name: string): boolean =>
      lines.some((l) => matches(l, name)) && !lines.some((l) => l.startsWith("!") && matches(l.slice(1), name));
    if (standalone && covers(STANDALONE_DIR)) {
      const text =
        `your .dockerignore (kept) excludes \`${STANDALONE_DIR}\` — the build context would ship WITHOUT the ` +
        `agent workspace entirely (the deployed box has no persona/config and crash-loops). Remove that line ` +
        `from it before deploying.`;
      if (run) return { ok: false, gate: text };
      messages.push({ level: "warn", text });
    }
    const secretExcludes = [".secrets", ".env"].filter((n) => !covers(n));
    if (secretExcludes.length > 0) {
      const text =
        `your .dockerignore (kept) lacks ${secretExcludes.map((s) => `\`**/${s}\``).join(" and ")} — the build ` +
        `context would BAKE SECRETS INTO THE IMAGE. Add the exclude(s) before deploying.`;
      if (run) return { ok: false, gate: text };
      messages.push({ level: "warn", text });
    }
    if (!covers(".state")) {
      messages.push({
        level: "warn",
        text: `your .dockerignore (kept) lacks \`**/.state\` — the build machine's sessions/channel state would ship in the image. Add it.`,
      });
    }
    if (!lines.some((l) => l === "**/node_modules" || l === "**/node_modules/")) {
      messages.push({
        level: "warn",
        text:
          `your .dockerignore lacks \`**/node_modules\` — the build machine's node_modules ` +
          `(native binaries for YOUR OS) would be uploaded and clobber the image's freshly-installed ones. ` +
          `Add \`**/node_modules\` to it.`,
      });
    }
    if (lines.some((l) => l === ".git" || l === "/.git" || l === ".git/" || l === "**/.git")) {
      messages.push({
        level: "note",
        text:
          `your .dockerignore excludes .git — the baked copy ships WITHOUT history/remote, so the agent ` +
          `cannot pull/commit/push it; it must \`git clone\` its repo in the workbench instead (or remove the .git line).`,
      });
    }
  }

  // Write-back mechanics are fastagent's (the policy is the persona's): the image carries the git
  // BINARY iff the baked workbench ships a `.git` — layout-neutral (history without the binary is a
  // dead loop; the binary without history is dead weight). A non-git workbench that still needs git
  // (the agent clones repos as its job) declares config.deploy.apt: ["git"] explicitly. Merged with
  // (never duplicating) config.deploy.apt.
  const apt = shipsGit ? [...new Set(["git", ...(config.deploy?.apt ?? [])])] : config.deploy?.apt;
  const container: ContainerInput = {
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt,
    standalone,
    shipsGit,
  };
  const port = config.http?.port ?? 8787;
  // What the agent declared it needs on the box (fastagent.config deploy.secrets) — carried like channel
  // secrets: listed in the runbook, set from the local env under --run, gated if a value is missing.
  const extraSecrets = config.deploy?.secrets ?? [];
  // deploy.apt only shapes the GENERATED Dockerfile. Warn ONLY when the kept Dockerfile is HAND-WRITTEN
  // (its apt won't include these) — a fastagent-generated one is handled by writeArtifacts. Don't suggest
  // --force here: it would overwrite the user's hand-written file.
  const dockerfileHome = join(root, "Dockerfile");
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
    routeChannels,
    longConnectionChannels,
    hasTimeTriggers,
    modelAuth,
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
