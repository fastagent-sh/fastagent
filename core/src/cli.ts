#!/usr/bin/env node
/**
 * fastagent CLI — the consumer of fastagent.config.ts (product entry point,
 * replacing hand-written entry scripts).
 *
 *   fastagent init  [dir] — scaffold a minimal runnable workspace
 *   fastagent dev   [dir] — assemble + serve a local HTTP channel (iteration)
 *   fastagent build [dir] — compile a self-contained artifact (core-design §10.3)
 *   fastagent start [dir] — run a built artifact in production posture (core-design §10.4)
 *
 * Process-level side effects (proxy dispatcher, .env loading) belong here — the CLI
 * is the application entry point.
 */
import { createServer } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";
import { createInvokeHandler } from "./channels/http.ts";
import { probeAuthSource } from "./engines/pi/auth.ts";
import { buildPiArtifact } from "./engines/pi/build.ts";
import { defaultGlobalSkillPaths, loadAgentDefinition } from "./engines/pi/definition.ts";
import { createPiAgentFromWorkspace } from "./engines/pi/dev.ts";
import { scaffoldWorkspace } from "./engines/pi/init.ts";
import { createPiAgentFromArtifact } from "./engines/pi/start.ts";

function usage(code: number): never {
  console.error(`usage:
  fastagent init  [dir]
  fastagent dev   [dir] [--port N] [--model provider/modelId] [--global-skills]
  fastagent build [dir] [--out dir] [--model provider/modelId] [--global-skills] [--force]
  fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir]

  dev    assemble the agent in dir (default .) and serve a local HTTP channel.
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         --global-skills   also load the machine's global skills (~/.pi/agent/skills,
                           ~/.agents/skills); default is definition-only (dev == deployed)
  init   scaffold a minimal runnable workspace in dir (default .): AGENTS.md, an example
         skill, fastagent.config.mjs, .gitignore. Refuses to overwrite an existing workspace.
  build  compile dir into a self-contained, relocatable artifact (default out:
         .fastagent/build): the source tree + materialized skills + manifest, minus
         node_modules/.git and anything .gitignore/.fastagentignore excludes (honored
         via a library, git is never invoked). Secrets are NOT auto-excluded — keep them
         in .gitignore or .fastagentignore. Source is untouched. The out dir is REPLACED
         wholesale (built to a temp dir, then published atomically); an in-tree --out must
         be under .fastagent/, else use an out-of-tree path with --force.
         --global-skills   materialize the machine's global skills into the artifact
         --force           allow an --out OUTSIDE the source tree (it will be replaced)
  start  run a built artifact (default dir .) in production posture: model/http come from
         the artifact's fastagent.json; skills are the artifact (never global).
         model precedence: --model > FASTAGENT_MODEL > manifest.model
         port precedence:  --port > PORT env > manifest.http.port > 8787
         sessions: --sessions-dir > FASTAGENT_SESSIONS_DIR > ./fastagent-sessions
                   (kept OUTSIDE the artifact so a redeploy never wipes conversations)`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    "sessions-dir": { type: "string" },
    force: { type: "boolean" },
    "global-skills": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) usage(0);

const [command, dirArg] = positionals;
const dir = resolve(dirArg ?? ".");
const globalSkills = values["global-skills"] ?? false;

if (command === "init") await runInit();
else if (command === "dev") await runDev();
else if (command === "build") await runBuild();
else if (command === "start") await runStart();
else usage(1);

async function runInit(): Promise<void> {
  const { created, skipped, intoNonEmpty, warnings } = await scaffoldWorkspace(dir).catch(failStartup);
  console.error(`[fastagent] initialized ${dir}`);
  if (created.length > 0) console.error(`  created: ${created.join(", ")}`);
  if (skipped.length > 0) console.error(`  kept existing: ${skipped.join(", ")}`);
  if (intoNonEmpty) {
    console.error(`  note: scaffolded into a non-empty directory; for a clean start, run \`fastagent init <name>\` (a fresh subdir)`);
  }
  for (const w of warnings) console.error(`[fastagent] warn: ${w}`);
  console.error(`  next steps:`);
  console.error(`    1. credentials — run \`pi login\`, or add a key to .env (e.g. OPENAI_API_KEY=...)`);
  console.error(`    2. optional   — edit fastagent.config.mjs to choose your model`);
  console.error(`    3. fastagent dev   # serve locally and iterate`);
}

/**
 * Parse + range-check a port string (CLI flag or env). Empty/whitespace (e.g. `PORT=` in an
 * env file) is treated as "not set" → undefined, so the `??` precedence chain falls through to
 * the next source instead of binding port 0 (an ephemeral port) — `Number("")` is 0. A
 * non-empty but non-decimal/out-of-range value is an argument error → exit 1. Strict `^\d+$`
 * (not `Number`) rejects hex/exponent/negative/whitespace coercion quirks.
 */
function parsePort(value: string | undefined, source: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > 65535) {
    console.error(`invalid ${source} "${value}": must be an integer 0-65535`);
    process.exit(1);
  }
  return Number(trimmed);
}

async function runDev(): Promise<void> {
  // Validate flags before any assembly work: argument errors must fail instantly,
  // not after the startup report. (config's http.port is range-checked by loadConfig.)
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir);
  // Node's fetch does not honor HTTPS_PROXY by itself; route through the local proxy
  // so blocked providers are reachable (reads HTTP(S)_PROXY/NO_PROXY from the env).
  // install() keeps fetch and the dispatcher on the SAME undici implementation —
  // pi does exactly this (core/http-dispatcher): Node 26's bundled fetch consuming
  // responses through npm undici's dispatcher skips gzip decompression, which turned
  // streamed turns into empty stopReason:"stop" messages (verified live 2026-06-11).
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  const { agent, definition, config, configPath, modelSpec } = await createPiAgentFromWorkspace(dir, {
    model: values.model,
    globalSkills,
  }).catch(failStartup);

  console.error(`[fastagent] dir:    ${definition.dir}`);
  console.error(`[fastagent] config: ${configPath ?? "(zero-config)"}`);
  console.error(`[fastagent] model:  ${modelSpec}`);
  console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  const loadedSkills = definition.skills.map((s) => s.name);
  console.error(
    `[fastagent] skills: ${loadedSkills.join(", ") || "(none)"}${globalSkills ? " (incl. global)" : ""}`,
  );
  if (!globalSkills) {
    // Definition-only by default: surface globals that exist on this machine but were
    // NOT loaded, so dropped skills are visible at dev time (not discovered at deploy).
    // A separate scan (dev-only diagnostic); the agent itself stays definition-only.
    const withGlobals = await loadAgentDefinition(dir, { skillPaths: defaultGlobalSkillPaths() }).catch(() => undefined);
    const available = (withGlobals?.skills ?? []).map((s) => s.name).filter((n) => !loadedSkills.includes(n));
    if (available.length > 0) {
      console.error(`[fastagent] ${available.length} global skill(s) available but not loaded: ${available.join(", ")}`);
      console.error(`            use in dev: --global-skills | ship: copy into skills/ (or build --global-skills)`);
    }
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  serve(agent, portFlag ?? config.http?.port ?? 8787);
}

async function runBuild(): Promise<void> {
  loadDotEnv(dir); // the model may come from FASTAGENT_MODEL in .env
  // Resolve a relative --out against the SOURCE dir (not the shell cwd), matching the
  // default (dir/.fastagent/build) and the in-tree guard — so `build pkg --out .fastagent/
  // build` targets pkg's, not cwd's. Absolute --out is unaffected.
  const outDir = values.out !== undefined ? resolve(dir, values.out) : join(dir, ".fastagent", "build");
  const { manifest, definition } = await buildPiArtifact(dir, outDir, {
    model: values.model,
    globalSkills,
    force: values.force ?? false,
  }).catch(failStartup);

  console.error(`[fastagent] built:  ${outDir}`);
  console.error(`[fastagent] model:  ${manifest.model}`);
  console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(
    `[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}${globalSkills ? " (incl. global)" : ""}`,
  );
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);
}

async function runStart(): Promise<void> {
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir); // env API keys + an optional PORT/FASTAGENT_MODEL override
  // Same proxy/undici setup as dev (see runDev): route fetch through the local proxy and
  // keep fetch + dispatcher on the same undici implementation.
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  const { agent, definition, manifest, modelSpec, sessionsDir } = await createPiAgentFromArtifact(dir, {
    model: values.model,
    sessionsDir: values["sessions-dir"] ? resolve(values["sessions-dir"]) : undefined,
  }).catch(failStartup);

  const provider = modelSpec.slice(0, modelSpec.indexOf("/"));
  const authSource = await probeAuthSource(provider);

  console.error(`[fastagent] start:    ${dir}`);
  console.error(`[fastagent] model:    ${modelSpec}`);
  console.error(`[fastagent] auth:     ${authSource === "none" ? "(none found)" : `${authSource} (${provider})`}`);
  console.error(`[fastagent] agents:   ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(`[fastagent] skills:   ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  console.error(`[fastagent] sessions: ${sessionsDir}`);
  // Visible footgun guard: a sessions dir inside the artifact is wiped by a redeploy that
  // replaces the artifact wholesale. Warn, don't block (running in place is legitimate).
  const rel = relative(dir, sessionsDir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    console.error(
      `[fastagent] warn: sessions dir is INSIDE the artifact; a redeploy that replaces the artifact ` +
        `will wipe conversations — use --sessions-dir to place them outside.`,
    );
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  serve(agent, portFlag ?? parsePort(process.env.PORT, "PORT env") ?? manifest.http?.port ?? 8787);
}

/**
 * Bind the HTTP channel, with a clean message instead of a raw stack on a listen failure
 * (the common case being EADDRINUSE — a port already in use). A listen error is a startup
 * problem, not a bug, so it exits like {@link failStartup} rather than crashing unhandled.
 */
function serve(agent: Parameters<typeof createInvokeHandler>[0], port: number): void {
  const server = createServer(createInvokeHandler(agent));
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") console.error(`port ${port} is already in use; choose another with --port`);
    else console.error(`cannot bind http channel on :${port}: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, () => {
    console.error(`[fastagent] http channel on :${port}`);
    console.error(`  curl -N -X POST localhost:${port}/invoke -d '{"session":"s1","text":"hi"}'`);
  });
}

/** .env (secrets) → process.env. Only a missing file is normal; surface anything else. */
function loadDotEnv(d: string): void {
  try {
    process.loadEnvFile(join(d, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** User-fixable startup problems (missing model / bad config / broken definition) are
 *  thrown as plain `Error` with actionable messages — print just the message. Anything
 *  else (TypeError, non-Error, …) is a bug: keep the full stack visible. */
function failStartup(error: unknown): never {
  if (error instanceof Error && error.constructor === Error) console.error(error.message);
  else console.error(error);
  process.exit(1);
}

function reportDefinitionWarnings(
  collisions: { name: string; winnerPath: string; loserPath: string }[],
  diagnostics: { code: string; message: string; path: string }[],
): void {
  for (const c of collisions) {
    console.error(`[fastagent] warn: skill "${c.name}" collision — using ${c.winnerPath}, ignoring ${c.loserPath}`);
  }
  for (const d of diagnostics) {
    console.error(`[fastagent] warn: ${d.code}: ${d.message} (${d.path})`);
  }
}
