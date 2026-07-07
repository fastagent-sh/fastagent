/**
 * The host-NEUTRAL deploy pre-flight: everything `fastagent deploy <host>` computes and checks BEFORE
 * the host branch (fly.ts / railway.ts). Model-travel gate, channel discovery, model-auth probe, the
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
import { defaultAuthPath, resolveStateRoot } from "../engines/pi/config.ts";
import { discoverChannelFiles } from "../engines/pi/channel.ts";
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
  config: FastagentConfig;
  modelSpec: string | undefined;
  /** `--run` fully deploys, so a model that won't travel is a GATE (a known crash-loop); else it warns. */
  run: boolean;
  /** `--force` regenerates artifacts, so the kept-hand-written-Dockerfile apt warning does not apply. */
  force: boolean;
  /** `--auth-path` / `FASTAGENT_AUTH_PATH`; falls back to the project default `<state root>/auth.json`. */
  authPathOverride: string | undefined;
}): Promise<DeployPreflight> {
  const { target, config, modelSpec, run, force, authPathOverride } = input;
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
  const discovered = await discoverChannelFiles(target);
  const channels = discovered.filter((c): c is ChannelKind => (CHANNEL_KINDS as string[]).includes(c));
  for (const c of discovered) {
    if (!channels.includes(c as ChannelKind)) {
      messages.push({ level: "note", text: `channel "${c}" is custom — set its secrets and webhook yourself` });
    }
  }

  // Probe auth from the SAME project-level file the opener/login use — not the global default, which would
  // miss a `fastagent login` credential and falsely report "none configured".
  const authPath = authPathOverride ?? defaultAuthPath(resolveStateRoot(target));
  const modelAuth = modelSpec ? await probeAuthSource(createPiModels({ authPath }), modelSpec) : undefined;

  // Container facts (shared by every host) + the warnings that follow. The generated Dockerfile targets
  // the workspace's package manager — bun or npm — made EXPLICIT rather than silently routing through npm.
  const hasPackageJson = await exists(join(target, "package.json"));
  const pkg = await readPackageJson(target);
  const { runtime, bunVersion, hasLockfile } = detectRuntime(target, pkg);
  const install = runtime === "bun" ? "bun install" : "npm install";
  const runner = runtime === "bun" ? "bunx fastagent" : "npx fastagent";
  const hasOtherLock =
    runtime === "node" && ((await exists(join(target, "pnpm-lock.yaml"))) || (await exists(join(target, "yarn.lock"))));
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
  // The code-path Dockerfile runs `${runner}`: that resolves the workspace's OWN dependency, so a
  // package.json missing it would make the CONTAINER fetch an unpinned build at runtime (offline-fragile).
  if (hasPackageJson && !("@kid7st/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies })) {
    messages.push({
      level: "warn",
      text:
        `package.json does not list @kid7st/fastagent — the image's \`${runner}\` would fetch it at runtime ` +
        `(offline-fragile, unpinned). Add it to dependencies and re-run \`${install}\`.`,
    });
  }
  const container: ContainerInput = {
    hasPackageJson,
    runtime,
    bunVersion,
    hasLockfile,
    version: await fastagentVersion(),
    apt: config.deploy?.apt,
  };
  const port = config.http?.port ?? 8787;
  // What the agent declared it needs on the box (fastagent.config deploy.secrets) — carried like channel
  // secrets: listed in the runbook, set from the local env under --run, gated if a value is missing.
  const extraSecrets = config.deploy?.secrets ?? [];
  // deploy.apt only shapes the GENERATED Dockerfile. Warn ONLY when the kept Dockerfile is HAND-WRITTEN
  // (its apt won't include these) — a fastagent-generated one is handled by writeArtifacts. Don't suggest
  // --force here: it would overwrite the user's hand-written file.
  if (config.deploy?.apt?.length && !force && (await exists(join(target, "Dockerfile")))) {
    if (!isGeneratedDockerfile(await readFile(join(target, "Dockerfile"), "utf8"))) {
      messages.push({
        level: "warn",
        text:
          `kept your hand-written Dockerfile — deploy.apt (${config.deploy.apt.join(", ")}) is ` +
          `NOT applied; install those packages in your Dockerfile.`,
      });
    }
  }

  return { ok: true, messages, channels, modelAuth, authPath, container, port, extraSecrets };
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
