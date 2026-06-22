/**
 * Start: run a built artifact in production posture (core-design §10.4).
 *
 * `start` is the deploy-time sibling of `createPiAgentFromWorkspace` (dev, dev.ts). Both are thin
 * command OPENERS over L2 `createPiAgentFromDefinition` — NOT ladder rungs (the reusable ladder is
 * L0–L2 in create.ts/invoke.ts); they only inject command-posture K-wiring into L2. The two differ
 * only in where their inputs come from and which K defaults they pick:
 *
 *   | concern  | dev (from workspace, dev.ts)    | start (from artifact, here)            |
 *   |----------|----------------------------------|-----------------------------------------|
 *   | model    | config.model                     | manifest.model (frozen at build)        |
 *   | tools    | loadConfig → resolveTools        | loadConfig → resolveTools (same)        |
 *   | skills   | definition-only (+ --global)     | definition-only (artifact is the truth) |
 *   | sessions | jsonl under <ws>/.fastagent/      | jsonl OUTSIDE the artifact (see below)   |
 *
 * Sessions live OUTSIDE the immutable artifact on purpose (the M/K split, core-design §10.1):
 * the artifact is relocatable and replaced wholesale on redeploy, so conversational state (K)
 * kept inside it would be wiped on every deploy and on every container restart. Default is the
 * shell-cwd-relative, visible `./fastagent-sessions/` (override: `sessionsDir` /
 * FASTAGENT_SESSIONS_DIR) — never the artifact's own `.fastagent/`.
 *
 * Node composition-root module (IO policy, see definition.ts): reads the manifest/config and
 * sets up the session dir on disk; the invoke path itself stays disk-free.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../../agent.ts";
import type { AuthResolver } from "./auth.ts";
import { type ArtifactManifest, MANIFEST_FILE } from "./build.ts";
import { type FastagentConfig, loadConfig, resolveModel, resolveModelSpec } from "./config.ts";
import { createPiAgentFromDefinition, piDefaultTools, resolveTools } from "./create.ts";
import { type LoadedDefinition, ensureStateDirSelfIgnored } from "./definition.ts";
import { jsonlSessionStore } from "./sessions.ts";
import { type ToolCollision, loadTools, mergeDiscoveredTools } from "./tool.ts";

/**
 * Read + validate `<artifactDir>/fastagent.json`. The manifest is machine-generated, so this
 * validates only the runtime-relevant fields (engine/model/http) and tolerates extra keys
 * (forward-compat with newer builds). A missing file means "not a built artifact" — fail
 * visibly with the fix, rather than a confusing downstream error.
 */
export async function loadManifest(artifactDir: string): Promise<ArtifactManifest> {
  const path = join(artifactDir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no ${MANIFEST_FILE} in "${artifactDir}": not a built artifact (run \`fastagent build\` first)`);
    }
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${path}: invalid JSON (corrupt artifact manifest)`);
  }
  if (!data || typeof data !== "object") {
    throw new Error(`${path}: must be a JSON object`);
  }
  const m = data as Record<string, unknown>;
  // engine identifies who can run the artifact; a non-pi artifact must not be silently served.
  if (m.engine !== "pi") {
    throw new Error(`${path}: engine "${String(m.engine)}" is not runnable by this build (expected "pi")`);
  }
  if (typeof m.model !== "string" || m.model === "") {
    throw new Error(`${path}: "model" must be a non-empty "provider/modelId" string`);
  }
  if (m.http !== undefined) {
    const http = m.http as Record<string, unknown> | null;
    if (typeof http !== "object" || http === null) {
      throw new Error(`${path}: "http" must be an object`);
    }
    const port = http.port;
    if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new Error(`${path}: "http.port" must be an integer 0-65535`);
    }
  }
  return data as ArtifactManifest;
}

export interface CreatePiAgentFromArtifactOptions {
  /** Model spec override (e.g. the CLI --model flag). Precedence: this > FASTAGENT_MODEL > manifest.model. */
  model?: string;
  /**
   * Session store directory. Precedence: this > FASTAGENT_SESSIONS_DIR > `<cwd>/fastagent-sessions`.
   * MUST resolve outside the artifact (the default is cwd-relative, and cwd is the shell launch
   * dir, not the artifact). Self-gitignored on create.
   */
  sessionsDir?: string;
  /** Model auth resolution. Defaults to the L2 default (resolvePiAuth: pi OAuth → env vars). */
  getApiKeyAndHeaders?: AuthResolver;
}

/**
 * Assemble a production agent from a built artifact: load the manifest (frozen model/http) and
 * the shipped config (code tools), resolve the model/sessions, then L2 with production wiring.
 * Returns everything an entry point needs to report what it assembled. Throws on a missing/bad
 * artifact or model (fail visibly at startup).
 */
export async function createPiAgentFromArtifact(
  artifactDir: string,
  options: CreatePiAgentFromArtifactOptions = {},
): Promise<{
  agent: Agent;
  definition: LoadedDefinition;
  manifest: ArtifactManifest;
  config: FastagentConfig;
  /** The resolved "provider/modelId" spec actually in use. */
  modelSpec: string;
  /** Absolute session store directory in use (for the startup report). */
  sessionsDir: string;
  /** Non-default tool names in effect: config.tools + discovered tools/. */
  toolNames: string[];
  /** Discovered tools dropped on a name clash with a default/config tool. */
  toolCollisions: ToolCollision[];
}> {
  const manifest = await loadManifest(artifactDir);
  // config.ts ships in the artifact for code tools (model/http come from the manifest).
  const { config } = await loadConfig(artifactDir);
  const modelSpec = resolveModelSpec(options.model, { model: manifest.model });
  if (!modelSpec) {
    // Unreachable in practice (loadManifest guarantees a non-empty model); kept as a visible floor.
    throw new Error(`missing model: artifact manifest has no model and none was provided via --model/FASTAGENT_MODEL`);
  }
  const sessionsDir =
    options.sessionsDir ?? process.env.FASTAGENT_SESSIONS_DIR ?? join(process.cwd(), "fastagent-sessions");
  // The session dir is runtime state outside the artifact: create + self-gitignore it (so a
  // start run inside a git repo does not show conversations as untracked).
  await mkdir(sessionsDir, { recursive: true });
  await ensureStateDirSelfIgnored(sessionsDir);
  // Discover tools/ (ships in the artifact as authored context) and merge with config.tools + defaults.
  const discovered = await loadTools(artifactDir);
  const { tools, collisions: crossCollisions } = mergeDiscoveredTools(
    resolveTools(config, artifactDir),
    discovered.tools,
  );
  const toolCollisions = [...discovered.collisions, ...crossCollisions];
  const defaultNames = new Set(piDefaultTools(artifactDir).map((t) => t.name));
  const toolNames = tools.map((t) => t.name).filter((n) => !defaultNames.has(n));
  const { agent, definition } = await createPiAgentFromDefinition(artifactDir, {
    model: resolveModel(modelSpec),
    // Code tools shipped in fastagent.config.* (appended after pi defaults); model/http are
    // already frozen in the manifest, but tools are functions and only live in the config file.
    tools,
    // Continuity from an external store, reconstructed per invoke (SPEC portable conformance).
    sessions: jsonlSessionStore({ dir: sessionsDir, cwd: artifactDir }),
    getApiKeyAndHeaders: options.getApiKeyAndHeaders,
  });
  return { agent, definition, manifest, config, modelSpec, sessionsDir, toolNames, toolCollisions };
}
