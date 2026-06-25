#!/usr/bin/env node
/**
 * fastagent CLI — the consumer of fastagent.config.ts (product entry point,
 * replacing hand-written entry scripts).
 *
 *   fastagent init  [dir] — scaffold a minimal runnable workspace
 *   fastagent models      — list available "provider/modelId" specs
 *   fastagent tool  <name> '<json>' [dir] — run one tool directly (no model)
 *   fastagent dev   [dir] — assemble + serve a local HTTP channel (iteration)
 *   fastagent build [dir] — compile a self-contained artifact (core-design §10.3)
 *   fastagent start [dir] — run a built artifact in production posture (core-design §10.4)
 *
 * Process-level side effects (proxy dispatcher, .env loading) belong here — the CLI
 * is the application entry point.
 */
import { spawn } from "node:child_process";
import { watch as watchTree } from "chokidar";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";
import type { Agent } from "./agent.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { type Routes, parseRouteKey, router, serveNode } from "./host/node.ts";
import { loadChannels } from "./engines/pi/channel.ts";
import { buildPiArtifact } from "./engines/pi/build.ts";
import { fastagentVersion } from "./engines/pi/version.ts";
import { listModels, loadConfig } from "./engines/pi/config.ts";
import { createPiModels, probeAuthSource } from "./engines/pi/models.ts";
import {
  type LoadedDefinition,
  defaultGlobalSkillPaths,
  loadAgentDefinition,
  loadRootIgnore,
} from "./engines/pi/definition.ts";
import { createPiAgentFromWorkspace } from "./engines/pi/dev.ts";
import { resolveTools } from "./engines/pi/create.ts";
import { assertChannelReady, channelExists, scaffoldChannel, scaffoldWorkspace } from "./engines/pi/init.ts";
import { loadTools, mergeDiscoveredTools } from "./engines/pi/tool.ts";
import { createPiAgentFromArtifact } from "./engines/pi/start.ts";

function usage(code: number): never {
  console.error(`usage:
  fastagent init   [dir] [--minimal] [--no-install]
  fastagent models
  fastagent tool   <name> '<json-args>' [dir]
  fastagent dev    [dir] [--port N] [--model provider/modelId] [--global-skills] [--no-watch]
  fastagent chat   [dir] [--model provider/modelId] [--global-skills]
  fastagent build [dir] [--out dir] [--model provider/modelId] [--global-skills] [--force]
  fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir]
  fastagent --version

  dev    assemble the agent in dir (default .) and serve a local HTTP channel.
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         --global-skills   also load the machine's global skills (~/.pi/agent/skills,
                           ~/.agents/skills); default is definition-only (dev == deployed)
  chat   open the SAME assembled agent in pi's interactive TUI (the real harness, not a
         crude REPL) — to try it locally before serving. Same model/tool/skill resolution
         as dev; pi handles login, sessions, and /resume natively.
  init   scaffold a runnable agent in dir (default .) and run npm install. Default is a
         complete agent: AGENTS.md, a skill, tools/word-count.ts (a code tool), config,
         package.json, .npmrc, .gitignore. Refuses to overwrite an existing workspace.
         --minimal      markdown-only (no package.json/tool/install) — a prompt+skills agent
         --no-install   scaffold but skip npm install
  models list the available "provider/modelId" specs (use one with --model or in the config).
  tool   run one tool (from tools/ or config.tools) directly with JSON args — no model, no
         server, no tokens. Fast feedback while authoring: fastagent tool add '{"a":2,"b":3}'
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
    minimal: { type: "boolean" },
    "no-install": { type: "boolean" },
    "no-watch": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});
if (values.version) {
  console.log(await fastagentVersion());
  process.exit(0);
}
if (values.help) usage(0);

const [command, dirArg] = positionals;
const dir = resolve(dirArg ?? ".");
const globalSkills = values["global-skills"] ?? false;

if (command === "init") await runInit();
else if (command === "models") runModels();
else if (command === "tool") await runTool();
else if (command === "dev") await runDev();
else if (command === "chat") await runChat();
else if (command === "build") await runBuild();
else if (command === "start") await runStart();
else if (command === "add") await runAdd();
else usage(1);

/** `fastagent models`: print every registered "provider/modelId" to stdout (pipe-friendly). */
function runModels(): void {
  for (const spec of listModels(createPiModels())) console.log(spec);
}

/**
 * `fastagent tool <name> '<json>' [dir]`: run one tool's body directly with JSON args — no model,
 * no server, no tokens. The tightest authoring feedback loop. Args are validated by the tool's
 * own schema (a defineTool tool returns an "Invalid arguments" result the same way the model sees).
 */
async function runTool(): Promise<void> {
  const name = positionals[1];
  const argsJson = positionals[2] ?? "{}";
  const toolDir = resolve(positionals[3] ?? ".");
  if (!name) {
    console.error(`usage: fastagent tool <name> '<json-args>' [dir]`);
    process.exit(1);
  }
  loadDotEnv(toolDir); // a tool may read a key from .env
  const { config } = await loadConfig(toolDir).catch(failStartup);
  const discovered = await loadTools(toolDir).catch(failStartup);
  // Same tool set dev/start mount (pi defaults + config.tools + discovered, deduped) so the
  // runner exercises exactly what gets served — a tool shadowed by a default/config tool is not
  // run here either; surface that collision instead of silently testing the wrong implementation.
  const { tools, collisions } = mergeDiscoveredTools(resolveTools(config, toolDir), discovered.tools);
  for (const c of [...discovered.collisions, ...collisions]) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) is shadowed by a default/config tool — not mounted`,
    );
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    console.error(`unknown tool "${name}". available: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
    process.exit(1);
  }
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    console.error(`invalid JSON args: ${argsJson}`);
    process.exit(1);
  }
  const result = await tool.execute(`cli-${name}`, args).catch(failStartup);
  const out =
    result?.details !== undefined
      ? result.details
      : (result?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
}

async function runInit(): Promise<void> {
  const minimal = values.minimal ?? false;
  const { complete, created, skipped, intoNonEmpty, warnings } = await scaffoldWorkspace(dir, { minimal }).catch(
    failStartup,
  );
  console.error(`[fastagent] initialized ${dir}${complete ? "" : " (minimal)"}`);
  if (created.length > 0) console.error(`  created: ${created.join(", ")}`);
  if (skipped.length > 0) console.error(`  kept existing: ${skipped.join(", ")}`);
  if (intoNonEmpty) {
    console.error(
      `  note: scaffolded into a non-empty directory; for a clean start, run \`fastagent init <name>\` (a fresh subdir)`,
    );
  }
  for (const w of warnings) console.error(`[fastagent] warn: ${w}`);

  // A complete agent has a tool that imports @kid7st/fastagent, so its deps must be installed.
  // Run `npm install` for the developer (the package is public; users handling a private package
  // will have run `npm login`). --no-install skips it; --minimal has no deps at all. A kept
  // (pre-existing) package.json is not ours, so we do not install over it.
  const willInstall = complete && !values["no-install"] && created.includes("package.json");
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install)…`);
    installFailed = (await npmInstall(dir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${dir} before \`fastagent dev\``);
  }

  // Next steps act on the scaffolded dir. For a named target (`fastagent init my-agent`) lead with
  // a `cd` so bare `fastagent dev` (which defaults to .) is correct. Credentials are NOT mentioned
  // here — `dev`/`start` prompt for them in context when missing (reportAuth); front-loading an
  // instruction a newcomer can't act on yet is noise.
  console.error(`  next steps:`);
  const rel = relative(process.cwd(), dir);
  // A relative target that climbs out of cwd (e.g. ../../../tmp/x) is noise — show the absolute path.
  if (rel !== "") console.error(`    cd ${rel.startsWith("..") ? dir : rel}`);
  if (complete && (values["no-install"] || installFailed)) console.error(`    npm install`);
  console.error(`    fastagent dev   # serve locally and iterate`);
}

/**
 * `fastagent add github [dir]`: scaffold `channels/<kind>.ts` — the third-party adapter import plus a
 * starter `on()` to edit. A channel always needs glue, so it is a file (not a config entry). Only
 * `github` today. Never clobbers an existing file (authored glue is not overwritten).
 */
async function runAdd(): Promise<void> {
  const kind = positionals[1];
  const target = resolve(positionals[2] ?? ".");
  if (kind !== "github") {
    console.error(`usage: fastagent add github [dir]   (the github channel is the only one today)`);
    process.exit(1);
  }
  // add SCAFFOLDS a channel into a ready workspace; it does not bootstrap one (that is `init`'s job).
  // Preconditions before the write, so a refusal is side-effect-free: the channel must not already
  // exist, and the workspace must be a fastagent-ready ESM package that declares the dependency.
  if (await channelExists(target, kind).catch(failStartup)) {
    failStartup(new Error(`channels/${kind}.ts already exists — edit it, or remove it to re-scaffold`));
  }
  await assertChannelReady(target).catch(failStartup);
  const file = await scaffoldChannel(target, kind).catch(failStartup);
  console.error(`[fastagent] created ${relative(target, file)}`);
  // Read-only secret-hygiene check (no mutation): `fastagent build` ships whatever the root
  // .gitignore/.fastagentignore don't exclude, so warn (don't refuse — on() may read a real env var)
  // when .env is not ignored, rather than blindly recommending the user put a secret there.
  const envIgnored = (await loadRootIgnore(target).catch(failStartup))?.ignores(".env") ?? false;
  if (!envIgnored) {
    console.error(
      `[fastagent] warn: .env is not gitignored — \`fastagent build\` would ship a secret placed there; add .env to .gitignore/.fastagentignore, or use a real env var`,
    );
  }
  console.error(`  next steps:`);
  console.error(`    npm install                      # if @kid7st/fastagent is not installed yet`);
  console.error(`    set GITHUB_WEBHOOK_SECRET${envIgnored ? " in .env (gitignored)" : ""}`);
  console.error(`    edit channels/github.ts — map events to intents in on()`);
  console.error(`    fastagent dev   # serve the webhook locally`);
}

/** Run `npm install` in `cwd` (inherit stdio so the user sees progress). Returns the exit code. */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1)); // npm not on PATH, etc.
  });
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

/**
 * Report which source provides the model's credentials — and, when none is found, surface a
 * remediation hint at STARTUP (dev and start alike) rather than letting the agent fail silently
 * at first invoke. Non-blocking: you may be iterating on prompts, or set credentials afterward.
 */
async function reportAuth(modelSpec: string): Promise<void> {
  const provider = modelSpec.slice(0, modelSpec.indexOf("/"));
  const source = await probeAuthSource(createPiModels(), modelSpec);
  console.error(`[fastagent] auth:   ${source === undefined ? "(none found)" : `${source} (${provider})`}`);
  if (source === undefined) {
    // Lead with `pi login`: the default model (openai-codex) is OAuth-only, and we cannot name
    // the right env var (it is provider-specific and pi-ai's mapping is not exported). Keep the
    // env path generic so we never advertise a key that can't satisfy the probed provider.
    console.error(
      `[fastagent] warn: no credentials for "${provider}" — run \`fastagent login\`, or set the provider's API key in .env; invokes will fail until then`,
    );
  }
}

type Assembled = Awaited<ReturnType<typeof createPiAgentFromWorkspace>>;

/** The agents/skills/tools/collisions report lines. */
function reportAgentsSkillsTools(a: Assembled): void {
  console.error(`[fastagent] agents: ${a.definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(
    `[fastagent] skills: ${a.definition.skills.map((s) => s.name).join(", ") || "(none)"}${globalSkills ? " (incl. global)" : ""}`,
  );
  if (a.toolNames.length > 0) console.error(`[fastagent] tools:  ${a.toolNames.join(", ")}`);
  reportToolCollisions(a.toolCollisions);
  reportDefinitionWarnings(a.definition.collisions, a.definition.diagnostics);
}

/** Startup-only diagnostic: machine global skills that exist but were not loaded (definition-only). */
async function reportAvailableGlobalSkills(definition: LoadedDefinition): Promise<void> {
  if (globalSkills) return;
  const loaded = definition.skills.map((s) => s.name);
  const withGlobals = await loadAgentDefinition(dir, { skillPaths: defaultGlobalSkillPaths() }).catch(() => undefined);
  const available = (withGlobals?.skills ?? []).map((s) => s.name).filter((n) => !loaded.includes(n));
  if (available.length > 0) {
    console.error(`[fastagent] ${available.length} global skill(s) available but not loaded: ${available.join(", ")}`);
    console.error(`            use in dev: --global-skills | ship: copy into skills/ (or build --global-skills)`);
  }
}

/**
 * `fastagent dev` hot-reload is process-restart, not in-process swap: the dev command is a
 * SUPERVISOR that spawns a worker (this same command with FASTAGENT_DEV_WORKER set) to assemble +
 * serve, and restarts that worker on any workspace edit. A fresh process per reload means what is
 * served is ALWAYS your latest code — no in-process module-cache staleness, including modules a
 * tool/config imports (the reason in-process busting was dropped). The supervisor never crashes;
 * a broken edit stops the worker with a loud error and waits for the next save to retry.
 */
async function runDev(): Promise<void> {
  // Worker (spawned by the supervisor) or `--no-watch`: assemble + serve once, no watching.
  if (process.env.FASTAGENT_DEV_WORKER === "1" || values["no-watch"]) {
    await serveOnce();
    return;
  }
  parsePort(values.port, "--port"); // flag-shape check (a non-integer port fails before spawning)
  runDevSupervisor();
}

/** Open the workspace agent in pi's interactive TUI (the pi-specific `chat` command). */
async function runChat(): Promise<void> {
  loadDotEnv(dir); // model spec + provider API keys may come from .env
  // Run the chat process IN the workspace. chat is workspace-scoped, and pi resolves a session's
  // cwd as `header.cwd ?? process.cwd()`; aligning process.cwd() with the workspace makes that
  // fallback land on the workspace for every session-replacement path (resume/import/fork/new),
  // so a cwd-less legacy/imported session never drifts to the launch directory. `dir` is absolute.
  process.chdir(dir);
  // Lazy-import: chat pulls pi's interactive TUI module graph (InteractiveMode, pi-tui). A static
  // import would load it on EVERY command; headless `start`/`dev` never need it. Runtime hygiene
  // only — the dependency (and install size) is unchanged.
  const { runPiChat } = await import("./engines/pi/chat.ts");
  await runPiChat(dir, { model: values.model, globalSkills }).catch(failStartup);
}

/** Assemble the workspace agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(): Promise<void> {
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir);
  // Node's fetch does not honor HTTPS_PROXY by itself; route through the local proxy, and keep
  // fetch + dispatcher on the SAME undici implementation (pi's core/http-dispatcher; otherwise
  // Node 26's bundled fetch skips gzip decompression — empty stopReason:"stop" messages).
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  const a = await createPiAgentFromWorkspace(dir, { model: values.model, globalSkills }).catch(failStartup);
  console.error(`[fastagent] dir:    ${a.definition.dir}`);
  console.error(`[fastagent] config: ${a.configPath ?? "(zero-config)"}`);
  console.error(`[fastagent] model:  ${a.modelSpec}`);
  await reportAuth(a.modelSpec);
  reportAgentsSkillsTools(a);
  await reportAvailableGlobalSkills(a.definition);
  // dev == deployed: serve the same channels/ the artifact would (default invoke when none declared).
  // routesFor constructs each discovered channel, which may throw on a misconfig (e.g. an unset
  // secret) — surface it as a clean startup error, not an unhandled stack.
  const routes = await routesFor(dir, a.agent).catch(failStartup);
  serve(routes, portFlag ?? a.config.http?.port ?? 8787);
}

/**
 * Supervisor: spawn the worker and restart it on debounced workspace edits. Each restart is a
 * fresh process (always-latest, no stale module cache). The supervisor itself never exits on a bad
 * edit — the worker fails loudly (its own startup error) and the supervisor waits for the next save.
 */
function runDevSupervisor(): void {
  let worker: ReturnType<typeof spawn> | undefined;
  let reloadPending = false;
  let everServed = false; // has any worker successfully bound (sent `ready`) yet?
  let timer: NodeJS.Timeout | undefined;

  const spawnWorker = (): void => {
    // ipc fd so the worker can signal readiness once it binds; stdio otherwise inherited.
    // biome-ignore lint/style/noNonNullAssertion: argv[1] is always the script path under a node entry
    const w = spawn(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, FASTAGENT_DEV_WORKER: "1" },
    });
    worker = w;
    w.on("message", (m: { type?: string }) => {
      if (m?.type === "ready") everServed = true;
    });
    w.on("exit", (code, signal) => {
      if (worker !== w) return; // already superseded
      worker = undefined;
      if (reloadPending) {
        reloadPending = false;
        spawnWorker(); // restart requested: the old worker has now exited, so the port is free
      } else if (!everServed) {
        // The worker failed BEFORE ever serving — a non-editable startup failure (bad flag,
        // EADDRINUSE, broken initial workspace) that saving cannot fix. Propagate the exit code so
        // `fastagent dev` fails like the old CLI did (and smoke tests don't hang). The worker
        // already printed the specific error (inherited stdio).
        process.exit(code ?? 1);
      } else {
        // A worker that HAD been serving stopped (a broken edit, or a crash). The edit is fixable;
        // the error is already printed. Wait for the next save to retry, do not loop or exit.
        console.error(`[fastagent] dev stopped (worker exited: ${signal ?? code}) — save a change to retry`);
      }
    });
  };

  const triggerReload = (): void => {
    console.error(`[fastagent] change detected — restarting…`);
    if (worker) {
      reloadPending = true;
      worker.kill("SIGTERM"); // the exit handler respawns once the port is released
    } else {
      spawnWorker(); // worker was down (broken edit) — retry now
    }
  };

  // Recursively watch the workspace, structurally ignoring machine-state dirs. The worker writes
  // jsonl sessions DEEP under .fastagent on every invoke, so watching it would restart dev on its
  // own writes; node_modules/.git are noise. Everything else is watched — tools, skills, AND helper
  // dirs a tool/config imports (e.g. lib/) — so a saved transitive import triggers the fresh-process
  // reload too. chokidar gives reliable cross-platform recursion + structural ignore that native
  // fs.watch cannot (its `filename` is not guaranteed, defeating a path-based filter).
  const watcher = watchTree(dir, {
    ignoreInitial: true, // the startup scan is not a change
    ignored: /(?:^|[\\/])(?:\.fastagent|node_modules|\.git)(?:[\\/]|$)/,
  });
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(triggerReload, 200);
  });
  watcher.on("error", (error) =>
    console.error(
      `[fastagent] warn: file watching error (${(error as Error).message}); some edits may need a manual restart`,
    ),
  );
  console.error(`[fastagent] watching for changes — edits restart the dev worker (--no-watch to disable)`);

  const shutdown = (): never => {
    worker?.kill("SIGTERM");
    void watcher.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  spawnWorker();
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
  // The build copies a .env only if the root .gitignore/.fastagentignore do NOT exclude it (the build
  // does not special-case secrets — definition.ts), so check the authoritative matcher, not mere
  // existence: an ignored .env is left behind (remind: secrets come from the deploy env); an
  // un-ignored .env was just SHIPPED into the artifact (a secret there is now in the deployable — warn).
  if (existsSync(join(dir, ".env"))) {
    if ((await loadRootIgnore(dir))?.ignores(".env")) {
      console.error(
        `[fastagent] note: .env is gitignored, so it is not in the artifact — provide its secrets via the deploy environment (e.g. GITHUB_WEBHOOK_SECRET)`,
      );
    } else {
      console.error(
        `[fastagent] warn: .env is NOT gitignored — the build SHIPPED it into the artifact; gitignore .env (or move the secret out) and rebuild`,
      );
    }
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);
}

async function runStart(): Promise<void> {
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir); // env API keys + an optional PORT/FASTAGENT_MODEL override
  // Same proxy/undici setup as dev (see runDev): route fetch through the local proxy and
  // keep fetch + dispatcher on the same undici implementation.
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  const { agent, definition, manifest, modelSpec, sessionsDir, toolNames, toolCollisions } =
    await createPiAgentFromArtifact(dir, {
      model: values.model,
      sessionsDir: values["sessions-dir"] ? resolve(values["sessions-dir"]) : undefined,
    }).catch(failStartup);

  console.error(`[fastagent] start:  ${dir}`);
  console.error(`[fastagent] model:  ${modelSpec}`);
  await reportAuth(modelSpec);
  console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (toolNames.length > 0) console.error(`[fastagent] tools:  ${toolNames.join(", ")}`);
  reportToolCollisions(toolCollisions);
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

  const routes = await routesFor(dir, agent).catch(failStartup);
  serve(routes, portFlag ?? parsePort(process.env.PORT, "PORT env") ?? manifest.http?.port ?? 8787);
  // No graceful drain: webhook turns run fire-and-forget and outlive a short shutdown grace anyway
  // (the engine's lease is the only concurrency guard); SIGTERM just exits. In-flight turns are lost
  // on redeploy — durable execution is the real fix (deferred).
}

/**
 * The routes this deployment serves: a default `GET /health` (deployment infra; a channel may
 * override it) plus the workspace's discovered `channels/` — or the default invoke channel at
 * POST /invoke when none are declared (zero-config still runs). Route collisions are surfaced.
 */
async function routesFor(workspaceDir: string, agent: Agent): Promise<Routes> {
  const { routes, collisions } = await loadChannels(workspaceDir, agent);
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`,
    );
  }
  const channels = Object.keys(routes).length > 0 ? routes : { "POST /invoke": createInvokeHandler(agent) };
  // Add a default GET /health unless a channel already covers it. Overlap, not exact-key: an
  // any-method `/health` also handles GET, so the built-in must step aside (an exact `GET /health`
  // would too). `POST /health` does NOT cover GET, so the default stays alongside it.
  const healthCovered = Object.keys(channels).some((k) => {
    const e = parseRouteKey(k);
    return e.path === "/health" && (e.method === undefined || e.method === "GET");
  });
  return healthCovered ? channels : { "GET /health": () => text("ok\n", 200), ...channels };
}

/**
 * Serve `routes` via the Node host. serveNode owns binding; the CLI owns policy: a clean message +
 * exit(1) on a bind failure (EADDRINUSE is a startup problem, not a bug), the dev-supervisor ready
 * signal, and the startup log.
 */
function serve(routes: Routes, port: number): void {
  serveNode(router(routes), { port }).listening.then(
    (boundPort) => {
      process.send?.({ type: "ready" }); // tell the dev supervisor we bound (no-op without an IPC channel)
      console.error(`[fastagent] http channel on :${boundPort}`);
      console.error(`[fastagent] routes: ${Object.keys(routes).join(", ") || "(none)"}`);
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") console.error(`port ${port} is already in use; choose another with --port`);
      else console.error(`cannot bind http channel on :${port}: ${error.message}`);
      process.exit(1);
    },
  );
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

function reportToolCollisions(collisions: { name: string; source: string }[]): void {
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) dropped — a default/config tool already uses that name`,
    );
  }
}
