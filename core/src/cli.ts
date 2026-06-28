#!/usr/bin/env node
/**
 * fastagent CLI — the product entry point and consumer of fastagent.config.ts. Process-level side
 * effects (proxy dispatcher, .env loading) belong here.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { autocomplete, isCancel, log, password, select, text as clackText } from "@clack/prompts";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, install as installUndiciFetch, setGlobalDispatcher } from "undici";
import type { Agent } from "./agent.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { type Routes, parseRouteKey, router, serveNode } from "./host/node.ts";
import { runDevSupervisor } from "./dev-supervisor.ts";
import { loadChannels } from "./engines/pi/channel.ts";
import { isModuleFile } from "./engines/pi/loader.ts";
import { fastagentVersion } from "./engines/pi/version.ts";
import {
  isValidPort,
  listModels,
  loadConfig,
  resolveModelSpec,
  resolveSessionsDirOverride,
} from "./engines/pi/config.ts";
import { FASTAGENT_AUTH_PATH } from "./engines/pi/auth.ts";
import { type LoginIO, loginFlow } from "./engines/pi/login.ts";
import { createPiModels, probeAuthSource } from "./engines/pi/models.ts";
import { assertInsideWorkspace, loadAgentDefinition, loadRootIgnore } from "./engines/pi/definition.ts";
import { runInvokeStream } from "./invoke-stream.ts";
import { reportDefinitionWarnings, reportToolCollisions } from "./engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "./engines/pi/dev.ts";
import { resolveWorkspaceTools } from "./engines/pi/create.ts";
import {
  type ChannelKind,
  CHANNEL_KINDS,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
  scaffoldWorkspace,
  vendorSkill,
} from "./engines/pi/init.ts";

function usage(code: number): never {
  console.error(`usage:
  fastagent init   [dir] [--minimal] [--no-install]
  fastagent models [search]
  fastagent info   [dir] [--json]
  fastagent tool   <name> '<json-args>' [dir]
  fastagent invoke <message> [dir] [--model provider/modelId]
  fastagent dev    [dir] [--port N] [--model provider/modelId] [--no-watch]
  fastagent chat   [dir] [--model provider/modelId]
  fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir]
  fastagent add   github | telegram | skill <source> [dir]
  fastagent login [provider]
  fastagent --version

  dev    assemble the agent in dir (default .) and serve a local HTTP channel.
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
  chat   open the SAME assembled agent in pi's interactive TUI (the real harness, not a
         crude REPL) — to try it locally before serving. Same model/tool/skill resolution
         as dev; pi handles login, sessions, and /resume natively.
  init   scaffold a runnable agent in dir (default .) and run npm install. Default is a
         complete agent: AGENTS.md, a skill, tools/word-count.ts (a code tool), config,
         package.json, .gitignore. Refuses to overwrite an existing workspace.
         --minimal      markdown-only (no package.json/tool/install) — a prompt+skills agent
         --no-install   scaffold but skip npm install
  models list the available "provider/modelId" specs ([search] filters by substring; use one with
         --model or in the config).
  info   print what dir (default .) ASSEMBLES into — model, AGENTS.md, skills, tools (+ collisions),
         channels, sessions, load diagnostics — WITHOUT serving. Read-only (never creates sessions /
         writes .gitignore); an unset model is reported, not fatal. --json for CI. Run it first when
         something looks off.
  tool   run one tool (from tools/ or config.tools) directly with JSON args — no model, no
         server, no tokens. Fast feedback while authoring: fastagent tool add '{"a":2,"b":3}'
  invoke run ONE turn against the assembled agent and exit — no server, no TUI. The reply streams
         to stdout, tool/diagnostics to stderr, a failed turn exits non-zero. The all-agent
         counterpart of tool, for CI smoke and quick checks. Same model resolution as dev.
  start  run the agent in dir (default .) in production posture — the SAME assembly as dev
         (your folder is the agent), just no file-watching. No build step: start reads the
         definition directly; model/http come from fastagent.config.ts (frozen by git).
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         port precedence:  --port > PORT env > fastagent.config.ts http.port > 8787
         sessions: --sessions-dir > FASTAGENT_SESSIONS_DIR > <dir>/.fastagent/sessions
                   (point FASTAGENT_SESSIONS_DIR at a volume so a redeploy never wipes conversations)
  add    github | telegram: scaffold channels/<kind>.ts (third-party adapter glue, an on() to edit).
         skill <source>: vendor an Agent Skills skill into skills/<name>/ (git ref owner/repo/path, a
         local path, or a bare name from ~/.agents/skills; --update re-fetches, review with git diff)
  login  authenticate a model provider into ~/.fastagent/auth.json: pick a method (subscription/OAuth
         or API key), then a provider that offers it (configured status shown). [provider] takes the
         method from what that provider supports, asked only when it offers both.`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    model: { type: "string" },
    "sessions-dir": { type: "string" },
    minimal: { type: "boolean" },
    "no-install": { type: "boolean" },
    "no-watch": { type: "boolean" },
    update: { type: "boolean" },
    json: { type: "boolean" },
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

if (command === "init") await runInit();
else if (command === "models") runModels();
else if (command === "tool") await runTool();
else if (command === "invoke") await runInvoke();
else if (command === "info") await runInfo();
else if (command === "dev") await runDev();
else if (command === "chat") await runChat();
else if (command === "start") await runStart();
else if (command === "add") await runAdd();
else if (command === "login") await runLogin();
else usage(1);

/** `fastagent models [search]`: print every registered "provider/modelId"; `[search]` filters by substring. */
function runModels(): void {
  const search = positionals[1]?.toLowerCase();
  const specs = listModels(createPiModels());
  const shown = search ? specs.filter((spec) => spec.toLowerCase().includes(search)) : specs;
  for (const spec of shown) console.log(spec);
  if (search && shown.length === 0) console.error(`no model matches "${positionals[1]}"`);
}

/** `fastagent tool <name> '<json>' [dir]`: run one tool's body directly with JSON args — no model. */
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
  // The same tool set dev/start mount (defaults + config.tools + discovered, deduped), so the runner
  // exercises exactly what gets served — a shadowed tool is surfaced, not silently run.
  const { tools, toolCollisions } = await resolveWorkspaceTools(config, toolDir).catch(failStartup);
  for (const c of toolCollisions) {
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

/** `fastagent invoke <message> [dir]`: run ONE turn against the assembled agent, then exit. */
async function runInvoke(): Promise<void> {
  const message = positionals[1];
  if (!message) {
    console.error(`usage: fastagent invoke <message> [dir]`);
    process.exit(2);
  }
  const invokeDir = resolve(positionals[2] ?? ".");
  loadDotEnv(invokeDir);
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();
  const { agent, modelSpec } = await createPiAgentFromWorkspace(invokeDir, { model: values.model }).catch(failStartup);
  console.error(`[fastagent] invoke: ${invokeDir} (${modelSpec})`);
  // Fresh session per invoke (one-shot, no resume). runInvokeStream maps events→IO: reply→stdout,
  // tool/failure→stderr, exit 1 iff the turn failed (so CI can gate on it).
  const exitCode = await runInvokeStream(
    agent.invoke({ session: randomUUID() }, { text: message }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  if (exitCode !== 0) process.exit(exitCode);
}

/** List channel file basenames in <dir>/channels/ — the authoring view (no import, unlike loadChannels). */
async function discoverChannelFiles(workspaceDir: string): Promise<string[]> {
  // The same containment guard loadChannels uses, so info reports the surface dev/start would accept.
  await assertInsideWorkspace(workspaceDir, "channels");
  let names: string[];
  try {
    names = await readdir(join(workspaceDir, "channels"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(isModuleFile)
    .map((n) => n.replace(/\.(ts|js|mjs)$/, ""))
    .sort();
}

/** `fastagent info [dir] [--json]`: print what the directory ASSEMBLES into, WITHOUT booting a server. Read-only. */
async function runInfo(): Promise<void> {
  loadDotEnv(dir); // skills/tools may read env at load time
  const { config, path: configPath } = await loadConfig(dir).catch(failStartup);
  const modelSpec = resolveModelSpec(values.model, config);
  const definition = await loadAgentDefinition(dir).catch(failStartup);
  const { toolNames, toolCollisions } = await resolveWorkspaceTools(config, dir).catch(failStartup);
  const channels = await discoverChannelFiles(dir).catch(failStartup);
  // The default sessions path WITHOUT creating it (info is read-only; dev/start mkdir it, info must not).
  const sessionsDir = resolveSessionsDirOverride(values["sessions-dir"]) ?? join(dir, ".fastagent", "sessions");

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          dir,
          configPath: configPath ?? null,
          model: modelSpec ?? null,
          instructions: definition.instructions !== undefined,
          skills: definition.skills.map((skill) => ({ name: skill.name, description: skill.description })),
          tools: toolNames,
          channels,
          sessionsDir,
          diagnostics: definition.diagnostics,
          skillCollisions: definition.collisions,
          toolCollisions,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`dir:      ${dir}`);
  console.log(`config:   ${configPath ?? "(none)"}`);
  console.log(`model:    ${modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or config.model)"}`);
  console.log(`agents:   ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.log(`skills:   ${definition.skills.map((skill) => skill.name).join(", ") || "(none)"}`);
  console.log(`tools:    ${toolNames.join(", ") || "(none)"}`);
  console.log(`channels: ${channels.join(", ") || "(none)"}`);
  console.log(`sessions: ${sessionsDir}`);
  reportToolCollisions(toolCollisions);
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);
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

  // Install deps only for a complete agent whose package.json we just wrote (a kept one is not ours).
  const willInstall = complete && !values["no-install"] && created.includes("package.json");
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install)…`);
    installFailed = (await npmInstall(dir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${dir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const rel = relative(process.cwd(), dir);
  // A relative target that climbs out of cwd (../../../tmp/x) is noise — show the absolute path.
  if (rel !== "") console.error(`    cd ${rel.startsWith("..") ? dir : rel}`);
  if (complete && (values["no-install"] || installFailed)) console.error(`    npm install`);
  console.error(`    fastagent dev   # serve locally and iterate`);
}

/** `fastagent add <channel> [dir]`: scaffold `channels/<kind>.ts` — the adapter import plus a starter `on()`. */
async function runAdd(): Promise<void> {
  const kind = positionals[1];
  if (kind === "skill") return runAddSkill();
  const target = resolve(positionals[2] ?? ".");
  if (!CHANNEL_KINDS.includes(kind as ChannelKind)) {
    console.error(`usage: fastagent add ${CHANNEL_KINDS.join(" | ")} [dir]  |  fastagent add skill <source> [dir]`);
    process.exit(1);
  }
  const channelKind = kind as ChannelKind;
  // Preconditions before the write, so a refusal is side-effect-free.
  if (await channelExists(target, channelKind).catch(failStartup)) {
    failStartup(new Error(`channels/${channelKind}.ts already exists — edit it, or remove it to re-scaffold`));
  }
  await assertChannelReady(target).catch(failStartup);
  const file = await scaffoldChannel(target, channelKind).catch(failStartup);
  console.error(`[fastagent] created ${relative(target, file)}`);
  // Secret-hygiene check (read-only): warn when .env is not ignored, since a deploy that copies the
  // directory would ship a secret placed there. Warn, not refuse — on() may read a real env var.
  const envIgnored = (await loadRootIgnore(target).catch(failStartup))?.ignores(".env") ?? false;
  if (!envIgnored) {
    console.error(
      `[fastagent] warn: .env is not gitignored — a deploy that copies the directory would ship a secret placed there; add .env to .gitignore/.fastagentignore, or use a real env var`,
    );
  }
  const { env, steps } = channelSetup(channelKind);
  console.error(`  next steps:`);
  console.error(`    npm install                      # if @kid7st/fastagent is not installed yet`);
  for (const v of env) console.error(`    set ${v}${envIgnored ? " in .env (gitignored)" : ""}`);
  for (const s of steps) console.error(`    ${s}`);
  console.error(`    fastagent dev   # serve locally`);
}

/** `fastagent add skill <source> [dir]`: vendor an Agent Skills skill into <dir>/skills/<name>/. */
async function runAddSkill(): Promise<void> {
  const source = positionals[2];
  const target = resolve(positionals[3] ?? ".");
  if (!source) {
    console.error(
      `add a skill — two ways:\n` +
        `  1. write your own (vibe): create skills/<name>/SKILL.md with name + description\n` +
        `     frontmatter; it's auto-discovered. No command needed — this is the common path.\n` +
        `  2. vendor an existing Agent Skills skill (copied in, git-tracked):\n` +
        `       fastagent add skill <source> [dir]\n` +
        `     source: a git ref (owner/repo/path, github default), a local path (./x, /abs), or a\n` +
        `             bare name found in your global skill dirs (~/.agents/skills, ~/.pi/agent/skills)\n` +
        `     --update overwrites an existing skill (re-fetch from source); review with git diff`,
    );
    process.exit(1);
  }
  const { name, description, dest, hasScripts, diagnostics, overwritten } = await vendorSkill(target, source, {
    update: values.update ?? false,
  }).catch(failStartup);
  console.error(`[fastagent] ${overwritten ? "updated" : "vendored"} skill "${name}" → ${dest}/`);
  if (overwritten) console.error(`  overwrote it — \`git diff ${dest}\` to review, \`git checkout ${dest}\` to revert`);
  if (description) console.error(`  ${description.length > 100 ? `${description.slice(0, 100)}…` : description}`);
  for (const d of diagnostics) console.error(`  warn: ${d.message}`);
  if (hasScripts) {
    console.error(
      `  warn: this skill ships scripts/ (executable code that runs in your agent) — review it before deploying`,
    );
  }
  console.error(`  next: mention "${name}" in AGENTS.md so the model knows when to use it; then \`fastagent dev\``);
}

/** `fastagent login [provider]`: authenticate a model provider into `~/.fastagent/auth.json`. */
async function runLogin(): Promise<void> {
  const io = terminalLoginIO();
  const result = await loginFlow(io, { provider: positionals[1] }).catch(failStartup);
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${FASTAGENT_AUTH_PATH}`);
}

/** Best-effort open a URL in the default browser; failure is fine (the URL is always printed too). */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
}

/** Login terminal IO via @clack/prompts: a searchable list once long, a hidden prompt for keys. */
function terminalLoginIO(): LoginIO {
  return {
    async select(message, options) {
      const r = await (options.length > 7 ? autocomplete : select)({ message, options });
      return isCancel(r) ? undefined : (r as string);
    },
    async prompt(message, opts) {
      const r = opts?.hidden
        ? await password({ message, signal: opts.signal })
        : await clackText({ message, signal: opts?.signal });
      return isCancel(r) ? undefined : (r as string);
    },
    note: (message) => log.info(message),
    openUrl: openBrowser,
  };
}

/** Run `npm install` in `cwd` (inherit stdio). Returns the exit code. */
function npmInstall(cwd: string): Promise<number> {
  return new Promise((resolveCode) => {
    const child = spawn("npm", ["install"], { cwd, stdio: "inherit" });
    child.on("close", (code) => resolveCode(code ?? 1));
    child.on("error", () => resolveCode(1));
  });
}

/**
 * Parse + range-check a port string (CLI flag or env). Empty/whitespace is "not set" → undefined, so
 * the `??` chain falls through instead of binding port 0 (`Number("")` is 0). A non-decimal or
 * out-of-range value is an argument error → exit 1.
 */
function parsePort(value: string | undefined, source: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed) || !isValidPort(Number(trimmed))) {
    console.error(`invalid ${source} "${value}": must be an integer 0-65535`);
    process.exit(1);
  }
  return Number(trimmed);
}

/** Report which source provides the model's credentials, surfacing a remediation hint at startup. Non-blocking. */
async function reportAuth(modelSpec: string): Promise<void> {
  const provider = modelSpec.slice(0, modelSpec.indexOf("/"));
  const source = await probeAuthSource(createPiModels(), modelSpec);
  console.error(`[fastagent] auth:   ${source === undefined ? "(none found)" : `${source} (${provider})`}`);
  if (source === undefined) {
    // Lead with `fastagent login`: the default model (openai-codex) is OAuth-only, and the
    // provider-specific env var name is not exported, so keep the env path generic.
    console.error(
      `[fastagent] warn: no credentials for "${provider}" — run \`fastagent login\`, or set the provider's API key in .env; invokes will fail until then`,
    );
  }
}

type Assembled = Awaited<ReturnType<typeof createPiAgentFromWorkspace>>;

/** The agents/skills/tools/collisions report lines. */
function reportAgentsSkillsTools(a: Assembled): void {
  console.error(`[fastagent] agents: ${a.definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(`[fastagent] skills: ${a.definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (a.toolNames.length > 0) console.error(`[fastagent] tools:  ${a.toolNames.join(", ")}`);
  reportToolCollisions(a.toolCollisions);
  reportDefinitionWarnings(a.definition.collisions, a.definition.diagnostics);
}

/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to
 * assemble + serve, restarting it on workspace edits. A fresh process per reload means what is served
 * is always the latest code, including modules a tool/config imports.
 */
async function runDev(): Promise<void> {
  if (process.env.FASTAGENT_DEV_WORKER === "1" || values["no-watch"]) {
    await serveOnce();
    return;
  }
  parsePort(values.port, "--port"); // flag-shape check before spawning
  runDevSupervisor(dir);
}

async function runChat(): Promise<void> {
  loadDotEnv(dir);
  // Run the chat process IN the workspace: pi resolves a session's cwd as `header.cwd ?? process.cwd()`,
  // so aligning process.cwd() with the workspace keeps a cwd-less session on the workspace. `dir` is absolute.
  process.chdir(dir);
  // Lazy-import: chat pulls pi's interactive TUI module graph; headless start/dev never need it.
  const { runPiChat } = await import("./engines/pi/chat.ts");
  await runPiChat(dir, { model: values.model }).catch(failStartup);
}

/** Assemble the workspace agent and serve it once (the dev worker; also the --no-watch path). */
async function serveOnce(): Promise<void> {
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir);
  // Route fetch through the local proxy and keep fetch + dispatcher on the same undici implementation
  // (otherwise Node's bundled fetch skips gzip decompression — empty stopReason:"stop" messages).
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  const a = await createPiAgentFromWorkspace(dir, { model: values.model }).catch(failStartup);
  console.error(`[fastagent] dir:    ${a.definition.dir}`);
  console.error(`[fastagent] config: ${a.configPath ?? "(zero-config)"}`);
  console.error(`[fastagent] model:  ${a.modelSpec}`);
  await reportAuth(a.modelSpec);
  reportAgentsSkillsTools(a);
  const routes = await routesFor(dir, a.agent).catch(failStartup);
  serve(routes, portFlag ?? a.config.http?.port ?? 8787);
}

async function runStart(): Promise<void> {
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir);
  setGlobalDispatcher(new EnvHttpProxyAgent());
  installUndiciFetch();

  // The same opener dev uses (single assembly source), just no watch.
  const sessionsDirOverride = resolveSessionsDirOverride(values["sessions-dir"]);
  const { agent, definition, config, modelSpec, sessionsDir, toolNames, toolCollisions } =
    await createPiAgentFromWorkspace(dir, { model: values.model, sessionsDir: sessionsDirOverride }).catch(failStartup);

  console.error(`[fastagent] start:  ${dir}`);
  console.error(`[fastagent] model:  ${modelSpec}`);
  await reportAuth(modelSpec);
  console.error(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  console.error(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (toolNames.length > 0) console.error(`[fastagent] tools:  ${toolNames.join(", ")}`);
  reportToolCollisions(toolCollisions);
  console.error(`[fastagent] sessions: ${sessionsDir}`);
  // Sessions default under the definition dir, which a redeploy may replace wholesale.
  if (sessionsDirOverride === undefined) {
    console.error(
      `[fastagent] note: sessions live under the definition dir; set FASTAGENT_SESSIONS_DIR to a ` +
        `persistent volume so a redeploy that replaces the dir does not wipe conversations.`,
    );
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  const routes = await routesFor(dir, agent).catch(failStartup);
  serve(routes, portFlag ?? parsePort(process.env.PORT, "PORT env") ?? config.http?.port ?? 8787);
  // No graceful drain: webhook turns run fire-and-forget; SIGTERM just exits, losing in-flight turns
  // (durable execution is the real fix, deferred).
}

/**
 * The routes this deployment serves: a default `GET /health` plus the workspace's discovered
 * `channels/` — or the default invoke channel at POST /invoke when none are declared.
 */
async function routesFor(workspaceDir: string, agent: Agent): Promise<Routes> {
  const { routes, collisions } = await loadChannels(workspaceDir, agent);
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`,
    );
  }
  const channels = Object.keys(routes).length > 0 ? routes : { "POST /invoke": createInvokeHandler(agent) };
  // Add a default GET /health unless a channel already covers it (overlap, not exact-key: an
  // any-method `/health` also handles GET, so the built-in steps aside).
  const healthCovered = Object.keys(channels).some((k) => {
    const e = parseRouteKey(k);
    return e.path === "/health" && (e.method === undefined || e.method === "GET");
  });
  return healthCovered ? channels : { "GET /health": () => text("ok\n", 200), ...channels };
}

/** Serve `routes` via the Node host. serveNode owns binding; the CLI owns policy (errors, ready signal, log). */
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

/**
 * User-fixable startup problems (missing model / bad config / broken definition) are thrown as plain
 * `Error` — print just the message. Anything else (TypeError, non-Error) is a bug: keep the stack.
 */
function failStartup(error: unknown): never {
  if (error instanceof Error && error.constructor === Error) console.error(error.message);
  else console.error(error);
  process.exit(1);
}
