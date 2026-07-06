#!/usr/bin/env node
/**
 * fastagent CLI — the product entry point and consumer of fastagent.config.ts. Process-level side
 * effects (proxy dispatcher, .env loading) belong here.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { parseArgs } from "node:util";
import type { Agent } from "./agent.ts";
import { logAgentLoop } from "./observe.ts";
import { log, setLogLevel } from "./log.ts";
import { installProxyFetch } from "./proxy.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { type Routes, parseRouteKey, router, serveNode } from "./host/node.ts";
import { runDevSupervisor } from "./dev-supervisor.ts";
import { announceWebhooks, startCloudflareTunnel } from "./tunnel.ts";
import { discoverChannelFiles, loadChannels } from "./engines/pi/channel.ts";
import { fastagentVersion } from "./version.ts";
import {
  defaultAuthPath,
  defaultSessionsDir,
  resolveStateRoot,
  isValidPort,
  listModels,
  loadConfig,
  resolveAuthPathOverride,
  resolveModelSpec,
  resolveSessionsDirOverride,
  rewriteConfigModel,
} from "./engines/pi/config.ts";
import { formatModelsCommand } from "./cli-models.ts";
import { type LoginIO, loginFlow } from "./engines/pi/login.ts";
import { configuredModelSpecs, createPiModels, probeAuthSource } from "./engines/pi/models.ts";
import { ensureStateRootSelfIgnored, isUnderDir, loadAgentDefinition } from "./engines/pi/definition.ts";
import { loadRootIgnore } from "./workspace.ts";
import { runInvokeStream } from "./invoke-stream.ts";
import { reportDefinitionWarnings, reportToolCollisions } from "./engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "./engines/pi/workspace.ts";
import { resolveWorkspaceTools } from "./engines/pi/create.ts";
import {
  type ChannelKind,
  CHANNEL_KINDS,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
} from "./scaffold/add-channel.ts";
import { exists, nextStepCd, scaffoldWorkspace } from "./scaffold/init.ts";
import { vendorSkill } from "./scaffold/vendor-skill.ts";
import { modelTravelIssue, parseFlyAppName, parseFlyRegion, planFlyDeploy, toFlyAppName } from "./deploy/fly.ts";
import { planRailwayDeploy } from "./deploy/railway.ts";
import { type RailwayRunner, deployRailwayRun } from "./deploy/railway-run.ts";
import { type FlyRunner, authSeedBytes, deployFlyRun } from "./deploy/fly-run.ts";
import { assembleSecrets } from "./deploy/secrets.ts";
import { registerTelegramWebhook } from "./channels/telegram/register-webhook.ts";

function usage(code: number): never {
  console.error(`usage:
  fastagent init   [dir] [--minimal] [--no-install]
  fastagent models [search]
  fastagent info   [dir] [--json] [--auth-path file]
  fastagent tool   <name> '<json-args>' [dir]
  fastagent invoke <message> [dir] [--model provider/modelId] [--auth-path file]
  fastagent dev    [dir] [--port N] [--model provider/modelId] [--auth-path file] [--no-watch] [--tunnel]
  fastagent chat   [dir] [--model provider/modelId]
  fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir] [--auth-path file] [--tunnel]
  fastagent add   github | telegram | skill <source> [dir]
  fastagent login [provider] [--auth-path file]
  fastagent --version

  dev    assemble the agent in dir (default .) and serve a local HTTP channel. AGENTS.md/skills
         are re-read every turn (edits go live next turn); edits to code inputs — tools/,
         channels/, fastagent.config.*, package.json, .env — restart the worker (--no-watch to
         disable). Files the agent writes as work product never trigger a restart.
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         --tunnel  expose it on a public HTTPS URL via a Cloudflare quick tunnel (needs cloudflared)
                   and auto-register the webhook channels (telegram setWebhook; github prints the URL)
  chat   open the SAME assembled agent in pi's interactive TUI (the real harness, not a
         crude REPL) — to try it locally before serving. Same model/tool/skill resolution
         as dev; pi handles login, sessions, and /resume natively.
  init   scaffold a runnable agent in dir (default .) and run npm install. Default is a
         self-iterating agent: AGENTS.md, a writing-great-skills example skill, a fetch-url
         code tool, config, package.json, .gitignore. Refuses to overwrite an existing workspace.
         --minimal      AGENTS.md + the example skill + config only (no code tool / package.json)
         --no-install   scaffold everything but skip npm install
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
         (your directory is the agent), just no file-watching. No build step: start reads the
         definition directly; model/http come from fastagent.config.ts (frozen by git).
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         port precedence:  --port > PORT env > fastagent.config.ts http.port > 8787
         state:    FASTAGENT_STATE_DIR > <dir>/.fastagent — the ONE machine-state root (auth,
                   sessions, channel state all derive from it); point it at a mounted volume so a
                   redeploy that replaces the directory never wipes state
         sessions: --sessions-dir > FASTAGENT_SESSIONS_DIR > <state>/sessions
         auth:     --auth-path > FASTAGENT_AUTH_PATH > <state>/auth.json (project-level;
                   point it at ~/.fastagent/auth.json to share one credential across projects)
         --tunnel  same as dev: a public HTTPS URL + auto-registered webhooks, for hosting a bot from
                   your own box without deploying (the quick-tunnel URL is ephemeral, not for production)
  add    github | telegram: scaffold channels/<kind>.ts — third-party adapter glue with the policy
         to edit (github maps events in on(); telegram routes in the optional route()).
         skill <source>: vendor an Agent Skills skill into skills/<name>/ (git ref owner/repo/path, a
         local path, or a bare name from ~/.agents/skills; --update re-fetches, review with git diff)
  deploy fly|railway [dir]: generate host config + Dockerfile/.dockerignore from the definition and
         print an ordered deploy runbook + the post-deploy webhook step. Does not run the host CLI — a
         coding agent (or you) executes the runbook. fly: fly.toml (autostop=suspend, state→volume).
         railway: railway.json (healthcheck /health); its volume/variables/App-Sleeping are dashboard/
         CLI steps the runbook states (see the runbook).
         --run             drive the host CLI to completion: app/service + volume + secrets + deploy +
                           telegram webhook (railway also mints the public domain). Carries your local
                           credential (env key or the OAuth auth.json) to the box. Stops at a gate (not
                           logged in, a missing secret) with one actionable line; needs flyctl / the
                           railway CLI. Without it: prints the runbook.
         --into-linked     (railway --run) provision INTO the project this dir is already linked to (skip
                           create). By default --run only creates on an unlinked dir and refuses a
                           pre-existing link (could be unrelated/production) — this is the explicit opt-in.
                           A routine redeploy of an already-provisioned agent is just 'railway up'.
         --stop            (fly only) autostop by stopping (cold start) instead of suspending (fast resume)
         --no-scale-to-zero (fly only) keep one machine running when idle (min_machines_running=1)
         --force           overwrite existing host config/Dockerfile/.dockerignore (else kept)
  login  authenticate a model provider into the project-level <state root>/auth.json — default
         <cwd>/.fastagent/auth.json (root: FASTAGENT_STATE_DIR; file: --auth-path / FASTAGENT_AUTH_PATH;
         run from $HOME for the global ~/.fastagent/auth.json): pick
         a method (subscription/OAuth or API key), then a provider that offers it (configured status
         shown). [provider] takes the method from what that provider supports, asked only when both.`);
  process.exit(code);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    model: { type: "string" },
    "sessions-dir": { type: "string" },
    "auth-path": { type: "string" },
    minimal: { type: "boolean" },
    "no-install": { type: "boolean" },
    "no-watch": { type: "boolean" },
    tunnel: { type: "boolean" },
    update: { type: "boolean" },
    force: { type: "boolean" },
    stop: { type: "boolean" },
    "no-scale-to-zero": { type: "boolean" },
    run: { type: "boolean" },
    "into-linked": { type: "boolean" },
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
else if (command === "deploy") await runDeploy();
else if (command === "login") await runLogin();
else usage(1);

/** `fastagent models [search]`: print every registered "provider/modelId"; `[search]` filters by substring. */
function runModels(): void {
  const { lines, error } = formatModelsCommand(listModels(createPiModels()), positionals[1]);
  for (const spec of lines) console.log(spec);
  if (error) console.error(error);
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
  installProxyFetch();
  await resolveFirstRunModel(invokeDir);
  const { agent, modelSpec, authPath } = await createPiAgentFromWorkspace(invokeDir, {
    model: values.model,
    authPath: resolveAuthPathOverride(values["auth-path"]),
  }).catch(failStartup);
  console.error(`[fastagent] invoke: ${invokeDir} (${modelSpec})`);
  await reportAuth(modelSpec, authPath);
  // Fresh session per invoke (one-shot, no resume). runInvokeStream maps events→IO: reply→stdout,
  // tool/failure→stderr, exit 1 iff the turn failed (so CI can gate on it).
  const exitCode = await runInvokeStream(
    agent.invoke({ session: randomUUID() }, { text: message }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  // Always exit explicitly: the undici proxy agent's keep-alive sockets would otherwise hold the
  // event loop open after a successful one-shot turn.
  process.exit(exitCode);
}

/** `fastagent info [dir] [--json]`: print what the directory ASSEMBLES into, WITHOUT booting a server. Read-only. */
async function runInfo(): Promise<void> {
  loadDotEnv(dir); // skills/tools may read env at load time
  const { config, path: configPath } = await loadConfig(dir).catch(failStartup);
  const modelSpec = resolveModelSpec(values.model, config);
  const definition = await loadAgentDefinition(dir).catch(failStartup);
  // A tool that fails to import (typically a missing dep before `npm install`) must NOT abort a
  // read-only inspect: report it and still show model/skills/channels/state. dev/start keep
  // failStartup — you cannot serve broken tools, but `info` exists to diagnose "something looks off".
  const tools = await resolveWorkspaceTools(config, dir)
    .then((r) => ({ names: r.toolNames, collisions: r.toolCollisions, error: undefined as string | undefined }))
    .catch((e: unknown) => ({ names: [] as string[], collisions: [], error: (e as Error).message }));
  const channels = await discoverChannelFiles(dir).catch(failStartup);
  // The default sessions/auth paths WITHOUT creating anything (info is read-only; dev/start mkdir/login
  // create them, info must not).
  const stateRoot = resolveStateRoot(dir);
  const sessionsDir = resolveSessionsDirOverride(values["sessions-dir"]) ?? defaultSessionsDir(stateRoot);
  const authPath = resolveAuthPathOverride(values["auth-path"]) ?? defaultAuthPath(stateRoot);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          dir,
          configPath: configPath ?? null,
          model: modelSpec ?? null,
          instructions: definition.instructions !== undefined,
          skills: definition.skills.map((skill) => ({ name: skill.name, description: skill.description })),
          tools: tools.names,
          toolError: tools.error ?? null,
          channels,
          stateRoot,
          sessionsDir,
          authPath,
          diagnostics: definition.diagnostics,
          skillCollisions: definition.collisions,
          toolCollisions: tools.collisions,
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
  console.log(`tools:    ${tools.error ? "(could not load — see warning below)" : tools.names.join(", ") || "(none)"}`);
  console.log(`channels: ${channels.join(", ") || "(none)"}`);
  console.log(`state:    ${stateRoot}`);
  console.log(`sessions: ${sessionsDir}`);
  console.log(`auth:     ${authPath}`);
  reportToolCollisions(tools.collisions);
  if (tools.error) log.warn(`[fastagent] ${tools.error}`);
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
  const cdTarget = nextStepCd(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (values["no-install"] || installFailed)) console.error(`    npm install`);
  console.error(`    fastagent dev   # serve locally and iterate`);
  console.error(`    fastagent add skill <owner/repo/path>   # vendor more skills from GitHub`);
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
  if (await appendChannelEnv(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] added ${channelKind} env vars to .env.example`);
  }
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
  for (const e of env) {
    const value = e.generate ? `=${randomBytes(24).toString("hex")}` : "";
    console.error(`    set ${e.name}${value} in .env${envIgnored ? " (gitignored)" : ""}   # ${e.hint}`);
  }
  for (const s of steps) console.error(`    ${s}`);
  console.error(`    fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
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

/**
 * `fastagent deploy <host> [dir]`: generate host artifacts from the resolved definition and print an
 * ordered deploy runbook. Host-scoped (`fly` | `railway` — the extension seam). It does NOT run the
 * host CLI: fastagent owns the two ends it uniquely knows (definition-aware artifacts; the post-deploy
 * webhook step), and hands the middle to a coding agent (or human) as a precise, values-resolved
 * runbook. The pre-flight (config/model/channels/container facts) is host-neutral; the host branch adds
 * its config file + runbook. Read-only on the definition; the only writes are the generated artifacts
 * (never clobbered without --force). `--run` (fly today) drives the host CLI instead of printing.
 */
async function runDeploy(): Promise<void> {
  const host = positionals[1];
  const target = resolve(positionals[2] ?? ".");
  if (host !== "fly" && host !== "railway") {
    console.error(`usage: fastagent deploy <fly|railway> [dir]`);
    process.exit(1);
  }
  loadDotEnv(target); // a custom provider/tool may read a key at config load
  const { config } = await loadConfig(target).catch(failStartup);
  const modelSpec = resolveModelSpec(values.model, config);
  // The deployed box resolves the model from fastagent.config.ts ONLY (in the image); a model set via
  // env/flag/.env doesn't travel. Surface it: warn for the runbook, hard gate for `--run` (don't deploy
  // a known crash-loop).
  const modelIssue = modelTravelIssue(config.model, modelSpec);
  if (modelIssue) {
    // `--run` fully deploys on either host now, so a model that won't travel would ship a known
    // crash-looping box — hard-stop before that. (Generate-only still just warns, for the runbook.)
    if (values.run) {
      console.error(`[fastagent] deploy stopped: ${modelIssue}`);
      process.exit(1);
    }
    console.error(`[fastagent] warn: ${modelIssue}`);
  }
  // Known channel kinds only — a custom channel's secrets/webhook are unknown to us; warn and let the
  // author wire them. probeAuthSource is best-effort (default providers): an env key becomes a secret,
  // a local OAuth/stored login surfaces as guidance, an unknown provider degrades to a generic note.
  const discovered = await discoverChannelFiles(target).catch(failStartup);
  const channels = discovered.filter((c): c is ChannelKind => (CHANNEL_KINDS as string[]).includes(c));
  for (const c of discovered) {
    if (!channels.includes(c as ChannelKind)) {
      console.error(`[fastagent] note: channel "${c}" is custom — set its secrets and webhook yourself`);
    }
  }
  // Probe auth from the SAME project-level file the opener/login use (default `<state root>/auth.json`,
  // or --auth-path / FASTAGENT_AUTH_PATH) — not the global default, which would miss a `fastagent login`
  // credential and falsely report "none configured".
  const authPath = resolveAuthPathOverride(values["auth-path"]) ?? defaultAuthPath(resolveStateRoot(target));
  const modelAuth = modelSpec ? await probeAuthSource(createPiModels({ authPath }), modelSpec) : undefined;
  // Container facts (shared by every host) + the warnings that follow. The generated Dockerfile is
  // npm-based (npm ci/install + npx); a pnpm/yarn workspace has no package-lock.json, so the npm-only
  // assumption is made EXPLICIT rather than silently routing them to `npm install`.
  const hasPackageJson = await exists(join(target, "package.json"));
  const hasLockfile = await exists(join(target, "package-lock.json"));
  const hasOtherLock = (await exists(join(target, "pnpm-lock.yaml"))) || (await exists(join(target, "yarn.lock")));
  // A code workspace with no package-lock.json builds via `npm install` (caret ranges resolve at build
  // time) — not a reproducible redeploy. A pnpm/yarn user gets an accurate message (their lockfile is
  // ignored by the npm Dockerfile), not the misleading "commit an npm lockfile".
  if (hasPackageJson && !hasLockfile) {
    console.error(
      hasOtherLock
        ? `[fastagent] warn: the generated Dockerfile is npm-based — your pnpm/yarn lockfile is NOT used (build runs ` +
            `\`npm install\`, not reproducible). Edit the Dockerfile for your package manager, or vendor a package-lock.json.`
        : `[fastagent] warn: no package-lock.json — the image build resolves deps at build time (not reproducible). ` +
            `Run \`npm install\` and commit the lockfile for pinned redeploys.`,
    );
  }
  // The code-path Dockerfile runs `npx fastagent`: that resolves the workspace's OWN dependency, so a
  // package.json missing it would make the CONTAINER fetch an unpinned build at runtime (offline-fragile,
  // the failure moved from build to prod). Warn at plan time, like `add`'s dep check (which throws).
  if (hasPackageJson) {
    let hasDep = false;
    try {
      const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
      hasDep = "@kid7st/fastagent" in { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      /* malformed package.json — the build would surface it; skip this check */
    }
    if (!hasDep) {
      console.error(
        `[fastagent] warn: package.json does not list @kid7st/fastagent — the image's \`npx fastagent\` would ` +
          `fetch it at runtime (offline-fragile, unpinned). Add it to dependencies and re-run \`npm install\`.`,
      );
    }
  }
  const container = { hasPackageJson, hasLockfile, version: await fastagentVersion() };
  const port = config.http?.port ?? 8787;

  // Railway: thin config file, scale-to-zero is a manual dashboard step, the URL is minted (see
  // planRailwayDeploy). --run drives the railway CLI to completion; otherwise print the runbook.
  if (host === "railway") {
    if (values.stop || values["no-scale-to-zero"]) {
      console.error(
        `[fastagent] warn: --stop/--no-scale-to-zero are Fly-only — Railway's App Sleeping is a dashboard toggle ` +
          `(the runbook states the manual step).`,
      );
    }
    // Railway service names are project-scoped (not globally unique like a Fly app); slug the dir
    // basename so a name with spaces/odd chars can't break the `railway add --service <name>` command.
    const serviceName =
      basename(target)
        .replace(/[^a-zA-Z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    const plan = planRailwayDeploy({ serviceName, modelAuth, channels, ...container });
    await writeArtifacts(target, plan.artifacts);
    if (values.run) return runDeployRailway(target, serviceName, modelAuth, authPath, channels);
    console.log(plan.runbook.join("\n"));
    return;
  }

  // host === "fly".
  if (values["into-linked"]) {
    console.error(
      `[fastagent] warn: --into-linked is railway-only (fly --run is idempotent — it reuses an existing app/volume)`,
    );
  }
  // The replay floor that makes scale-to-zero safe is Telegram-only (its L1 turn store). GitHub turns
  // are fire-and-forget (no replay), so the generated fly.toml keeps one machine running for them —
  // a note, not a warn, since the plan already did the safe thing (definition-aware autostop).
  if (channels.includes("github")) {
    console.error(
      `[fastagent] note: github turns have no replay — the generated fly.toml uses min_machines_running=1 ` +
        `(no scale-to-zero) so autostop can't drop an in-flight review. Set it to 0 to accept that trade.`,
    );
  }
  // Two consistent modes. KEEP (no --force): an existing fly.toml is authoritative — not rewritten,
  // and the runbook reads its `app=` (Fly app names are globally unique, so the basename guess may be
  // taken and the user renamed it). --force: the template is authoritative — the WHOLE fly.toml resets
  // (app→basename, region→iad, vm→defaults), so we do NOT round-trip `app` and warn that hand edits go.
  const flyTomlPath = join(target, "fly.toml");
  const flyTomlExists = await exists(flyTomlPath);
  const keptApp = flyTomlExists && !values.force ? parseFlyAppName(await readFile(flyTomlPath, "utf8")) : undefined;
  const appName = keptApp ?? toFlyAppName(basename(target));
  if (keptApp) console.error(`[fastagent] app: ${keptApp} (from fly.toml)`);
  if (flyTomlExists && values.force) {
    console.error(`[fastagent] warn: --force resets fly.toml to defaults (app, region, vm) — re-apply any hand edits`);
  }
  // Autostop flags shape the GENERATED fly.toml only. In KEEP mode (fly.toml exists, no --force) it is
  // not rewritten, so the flags would silently do nothing — surface that instead of a confusing no-op.
  if (flyTomlExists && !values.force && (values.stop || values["no-scale-to-zero"])) {
    console.error(
      `[fastagent] warn: --stop/--no-scale-to-zero only shape a freshly generated fly.toml — yours exists and ` +
        `was kept. Edit auto_stop_machines/min_machines_running in fly.toml, or pass --force to regenerate.`,
    );
  }
  const plan = planFlyDeploy({
    appName,
    port,
    modelAuth,
    channels,
    ...container,
    autostop: values.stop ? "stop" : "suspend",
    scaleToZero: !values["no-scale-to-zero"],
  });
  await writeArtifacts(target, plan.artifacts);
  if (values.run) return runDeployFly(target, appName, modelAuth, authPath, channels, flyTomlPath);
  console.log(plan.runbook.join("\n"));
}

/** Write each generated artifact, skipping any that exists unless --force (never clobber hand edits). */
async function writeArtifacts(target: string, artifacts: { path: string; content: string }[]): Promise<void> {
  for (const a of artifacts) {
    const abs = join(target, a.path);
    if (!values.force && (await exists(abs))) {
      console.error(`[fastagent] kept ${a.path} (exists — pass --force to overwrite)`);
      continue;
    }
    await writeFile(abs, a.content);
    console.error(`[fastagent] wrote ${a.path}`);
  }
}

/**
 * `deploy fly --run`: drive flyctl to completion (idempotent, resumable). Gathers the secret VALUES
 * from the local env — the model key (env auth) or the whole auth.json as a `FASTAGENT_AUTH_SEED` seed
 * (OAuth/stored auth: the deployed box materializes it onto the /data volume on first boot, so a
 * personal deploy runs on the SAME subscription) plus channel secrets — then runs the flyctl steps
 * behind the {@link FlyRunner} seam (spawned `fly`, cwd = the workspace so the build context is the agent).
 */
async function runDeployFly(
  target: string,
  appName: string,
  modelAuth: string | undefined,
  authPath: string,
  channels: ChannelKind[],
  flyTomlPath: string,
): Promise<void> {
  const fly: FlyRunner = (args, opts) =>
    new Promise((res) => {
      const child = spawn("fly", args, {
        cwd: target,
        stdio: [opts?.input ? "pipe" : "inherit", opts?.capture ? "pipe" : "inherit", "inherit"],
      });
      let out = "";
      child.stdout?.on("data", (d) => (out += String(d)));
      if (opts?.input) child.stdin?.end(opts.input);
      child.on("close", (code) => res({ code: code ?? 1, stdout: out }));
      child.on("error", () => res({ code: 127, stdout: "" })); // ENOENT: flyctl not on PATH
    });
  // Fail fast if flyctl is absent (spawn ENOENT → 127), with the install link — not a confusing auth gate.
  if ((await fly(["version"], { capture: true })).code === 127) {
    console.error(`[fastagent] flyctl not found — install it: https://fly.io/docs/flyctl/install, then re-run`);
    process.exit(1);
  }

  const region = parseFlyRegion(await readFile(flyTomlPath, "utf8")) ?? "iad";
  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    env: process.env,
  });
  // Model credential has its OWN remediation (login), distinct from a missing secret's (.env) — gate it
  // here, not through missingSecrets, so the message isn't a contradictory mash of both.
  if (needsModelCredential) {
    console.error(
      `[fastagent] deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
    );
    process.exit(1);
  }

  const outcome = await deployFlyRun(
    { appName, region, secrets, missingSecrets, channels, flyConfig: "fly.toml" },
    fly,
    (m) => console.error(`[fastagent] ${m}`),
    (baseUrl) => registerTelegramWebhook(baseUrl),
  );
  if (!outcome.ok) {
    console.error(`[fastagent] deploy stopped: ${outcome.gate}`);
    process.exit(1);
  }
  console.error(`[fastagent] deployed → https://${appName}.fly.dev`);
}

/**
 * `deploy railway --run`: drive the railway CLI to completion. Mirrors {@link runDeployFly} — same
 * credential carry (env key OR the OAuth auth.json as `FASTAGENT_AUTH_SEED`) via {@link assembleSecrets},
 * same runner seam (spawned `railway`, cwd = the workspace so `railway up`'s upload is the agent). The
 * Railway-specific sequence (linked-check → init/add/volume when fresh → variables → up → domain →
 * webhook) lives in {@link deployRailwayRun}; see there for why Railway differs from Fly.
 */
async function runDeployRailway(
  target: string,
  name: string,
  modelAuth: string | undefined,
  authPath: string,
  channels: ChannelKind[],
): Promise<void> {
  const railway: RailwayRunner = (args, opts) =>
    new Promise((res) => {
      const child = spawn("railway", args, {
        cwd: target,
        stdio: [opts?.input ? "pipe" : "inherit", opts?.capture ? "pipe" : "inherit", "inherit"],
      });
      let out = "";
      child.stdout?.on("data", (d) => (out += String(d)));
      if (opts?.input) child.stdin?.end(opts.input);
      child.on("close", (code) => res({ code: code ?? 1, stdout: out }));
      child.on("error", () => res({ code: 127, stdout: "" })); // ENOENT: railway not on PATH
    });
  // Fail fast if the railway CLI is absent (spawn ENOENT → 127), with the install link.
  if ((await railway(["--version"], { capture: true })).code === 127) {
    console.error(`[fastagent] railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run`);
    process.exit(1);
  }

  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    env: process.env,
  });
  // Model credential has its OWN remediation (login), distinct from a missing secret's (.env).
  if (needsModelCredential) {
    console.error(
      `[fastagent] deploy stopped: no model credential — run \`fastagent login\`, or set a provider API key in .env, then re-run`,
    );
    process.exit(1);
  }

  const outcome = await deployRailwayRun(
    { name, mountPath: "/data", secrets, missingSecrets, channels, intoLinked: !!values["into-linked"] },
    railway,
    (m) => console.error(`[fastagent] ${m}`),
    (baseUrl) => registerTelegramWebhook(baseUrl),
  );
  if (!outcome.ok) {
    console.error(`[fastagent] deploy stopped: ${outcome.gate}`);
    process.exit(1);
  }
  console.error(`[fastagent] deployed → ${outcome.url}`);
}

/**
 * `fastagent login [provider]`: authenticate a model provider into the project-level auth file
 * (`<cwd>/.fastagent/auth.json`) by default, or `--auth-path`/`FASTAGENT_AUTH_PATH`. The positional is
 * the PROVIDER (not a dir), so the project is cwd — `cd` into your agent before logging in (running it
 * from $HOME writes the global `~/.fastagent/auth.json`).
 *
 * Creates and self-ignores `<cwd>/.fastagent/` (the credential's gitignored home) BEFORE the auth flow,
 * so the secret can never land untracked — a flow that then fails (bad provider, abort) leaves that
 * empty state dir behind, by design (no secret without its `.gitignore`). Skipped for the HOME-global dir.
 */
async function runLogin(): Promise<void> {
  const loginDir = process.cwd();
  loadDotEnv(loginDir); // FASTAGENT_AUTH_PATH / a proxy (HTTPS_PROXY) may be configured in the project .env
  installProxyFetch(); // the OAuth token exchange must go through HTTPS_PROXY (region-locked providers)
  const stateRoot = resolveStateRoot(loginDir);
  const authPath = resolveAuthPathOverride(values["auth-path"]) ?? defaultAuthPath(stateRoot);
  // login is the command that CREATES the credential file, so the leak guard binds HERE too (not only
  // in the opener): on an adapted project dir, a `login` before the first dev/start would otherwise
  // leave the secret untracked-but-committable. Unlike the opener (which populates the WHOLE root, so
  // it always self-ignores an in-tree root), login writes ONLY auth.json — so guard iff the credential
  // actually lands under the in-tree root. An external `--auth-path`/`FASTAGENT_AUTH_PATH` writes
  // nothing in-tree (don't create an empty `.fastagent`); the guard also skips the HOME-global root.
  if (isUnderDir(authPath, stateRoot)) await ensureStateRootSelfIgnored(loginDir, stateRoot);
  const io = terminalLoginIO();
  const result = await loginFlow(io, { provider: positionals[1], authPath }).catch(failStartup);
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${authPath}`);
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
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
    note: (message) => clackLog.info(message),
    openUrl: openBrowser,
  };
}

/**
 * Materialize `FASTAGENT_AUTH_SEED` (base64 of an auth.json, set by `deploy fly --run`) onto the
 * writable state root ONCE — only when the seed is set AND the auth file is absent, so a refreshed
 * volume copy is never clobbered by the stale seed. Lets a deploy carry the operator's local
 * OAuth/API credential so the box runs on the SAME subscription. No-op locally (the seed is unset).
 */
async function maybeSeedAuth(authPath: string): Promise<void> {
  const bytes = authSeedBytes(process.env.FASTAGENT_AUTH_SEED, await exists(authPath));
  if (!bytes) return;
  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(authPath, bytes);
  log.info(`[fastagent] seeded ${authPath} from FASTAGENT_AUTH_SEED (first boot)`);
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
async function reportAuth(modelSpec: string, authPath: string): Promise<void> {
  const provider = modelSpec.slice(0, modelSpec.indexOf("/"));
  const source = await probeAuthSource(createPiModels({ authPath }), modelSpec);
  log.info(`[fastagent] auth:   ${source === undefined ? "(none found)" : `${source} (${provider})`} — ${authPath}`);
  if (source !== undefined) return;
  // Lead with `fastagent login`: it covers every provider (including OAuth-only ones like openai-codex),
  // and the provider-specific env var name is not exported, so keep the env path generic. login writes to
  // this same project-level path, so a follow-up `fastagent login` here fixes it in place.
  log.warn(
    `[fastagent] no credentials for "${provider}" — run \`fastagent login\`, or set the provider's API key in .env; invokes will fail until then`,
  );
}

/** Both stdin and stdout are a terminal — the precondition for an interactive prompt. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * First-run model resolution for the serving commands. When no model is set (flag/env/config), and
 * we're on a TTY, pick one from the providers the user is logged into and persist the choice. A no-op
 * when a model is already set; on a non-TTY (CI/deploy) or with nothing configured it stays silent and
 * lets the opener raise its clear "missing model" error. The pick is exported to FASTAGENT_MODEL so a
 * spawned `dev` worker inherits it, and best-effort written back to the config so the next run is quiet.
 */
async function resolveFirstRunModel(workspaceDir: string): Promise<void> {
  const { config, path: configPath } = await loadConfig(workspaceDir).catch(failStartup);
  if (resolveModelSpec(values.model, config)) return; // already set (flag > FASTAGENT_MODEL > config)
  if (!isInteractive()) return; // CI/deploy: the opener throws the actionable missing-model error

  const authPath = resolveAuthPathOverride(values["auth-path"]);
  let specs: string[];
  try {
    specs = await configuredModelSpecs(createPiModels({ authPath }));
  } catch (error) {
    // Enumerating providers/auth threw — a system fault (a corrupt auth store, a throwing provider),
    // NOT "not logged in". Surface it instead of masking it as the login hint; the opener then still
    // raises the clear missing-model error.
    log.warn(`[fastagent] could not list configured models: ${(error as Error).message}`);
    return;
  }
  if (specs.length === 0) {
    log.warn(
      `[fastagent] no model set and no authenticated provider — run \`fastagent login\`, then \`fastagent dev\``,
    );
    return;
  }
  const r = await (specs.length > 7 ? autocomplete : select)({
    message: "Choose a model for this agent",
    options: specs.map((s) => ({ value: s, label: s })),
  });
  if (isCancel(r)) return; // cancelled: let the opener report the missing model
  const chosen = r as string;
  process.env.FASTAGENT_MODEL = chosen; // this process + any spawned dev worker inherits it
  await persistModelChoice(workspaceDir, configPath, chosen);
}

/**
 * Best-effort persist the picked model so the next run does not prompt. Only rewrites the commented
 * `model:` placeholder the scaffold writes (or an existing `model:` line); anything else (zero-config,
 * a hand-shaped config) is left untouched with a printed hint. Never throws — persistence is a convenience.
 */
async function persistModelChoice(workspaceDir: string, configPath: string | undefined, spec: string): Promise<void> {
  const hint = (): void =>
    console.error(
      `[fastagent] using ${spec} for this run; set \`model: ${JSON.stringify(spec)}\` in your config to persist`,
    );
  if (!configPath) return hint();
  try {
    const replaced = rewriteConfigModel(await readFile(configPath, "utf8"), spec);
    if (!replaced) return hint();
    await writeFile(configPath, replaced);
    console.error(`[fastagent] saved model ${JSON.stringify(spec)} to ${relative(workspaceDir, configPath)}`);
  } catch {
    hint();
  }
}

type Assembled = Awaited<ReturnType<typeof createPiAgentFromWorkspace>>;

/** The agents/skills/tools/collisions report lines. */
function reportAgentsSkillsTools(a: Assembled): void {
  log.info(`[fastagent] agents: ${a.definition.instructions ? "AGENTS.md" : "(none)"}`);
  log.info(`[fastagent] skills: ${a.definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (a.toolNames.length > 0) log.info(`[fastagent] tools:  ${a.toolNames.join(", ")}`);
  reportToolCollisions(a.toolCollisions);
  reportDefinitionWarnings(a.definition.collisions, a.definition.diagnostics);
}

/**
 * `fastagent dev`: a SUPERVISOR that spawns a worker (this command with FASTAGENT_DEV_WORKER set) to
 * assemble + serve, restarting it on workspace edits. A fresh process per reload means what is served
 * is always the latest code, including modules a tool/config imports.
 */
async function runDev(): Promise<void> {
  setLogLevel("debug"); // dev posture: verbose, includes the debug turn trace (content) — supervisor and worker both
  const isWorker = process.env.FASTAGENT_DEV_WORKER === "1";
  // Pick a model interactively once, in the parent (both watch and --no-watch have a TTY); a spawned
  // watch worker inherits the choice via FASTAGENT_MODEL, so it must not prompt again. Load .env and
  // the proxy FIRST (as invoke/start do): the picker reads FASTAGENT_MODEL and provider keys from
  // .env, and getAuth's OAuth refresh must go through HTTPS_PROXY. The worker re-loads both in serveOnce.
  if (!isWorker) {
    loadDotEnv(dir);
    installProxyFetch();
    await resolveFirstRunModel(dir);
  }
  if (isWorker || values["no-watch"]) {
    await serveOnce();
    return;
  }
  parsePort(values.port, "--port"); // flag-shape check before spawning
  runDevSupervisor(dir, { tunnel: values.tunnel ?? false });
}

/**
 * Start a Cloudflare tunnel + announce/register webhooks once the server is bound — unless this is a
 * watch-supervisor worker, where the supervisor owns the long-lived tunnel so the public URL survives
 * reloads.
 */
function maybeTunnel(workspaceDir: string, boundPort: number): void {
  if (!values.tunnel || process.env.FASTAGENT_DEV_WORKER === "1") return;
  void startCloudflareTunnel(boundPort).then((t) => {
    if (!t) return;
    void announceWebhooks(workspaceDir, t.url);
    // Single-process (start / --no-watch): close the tunnel on exit (watch mode's supervisor owns its own).
    const cleanup = (): never => {
      t.close();
      process.exit(0);
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  });
}

async function runChat(): Promise<void> {
  loadDotEnv(dir);
  installProxyFetch(); // model calls (and the login dialog) must go through the proxy too
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
  installProxyFetch();

  const a = await createPiAgentFromWorkspace(dir, {
    model: values.model,
    authPath: resolveAuthPathOverride(values["auth-path"]),
  }).catch(failStartup);
  log.info(`[fastagent] dir:    ${a.definition.dir}`);
  log.info(`[fastagent] config: ${a.configPath ?? "(zero-config)"}`);
  log.info(`[fastagent] model:  ${a.modelSpec}`);
  await reportAuth(a.modelSpec, a.authPath);
  reportAgentsSkillsTools(a);
  // Trace each turn's agent loop (tool calls + reply) to the log at debug level — shown in dev, gated
  // out in start (level info), keeping end-user content out of production logs. Wired in both postures.
  const routes = await routesFor(dir, logAgentLoop(a.agent), a.stateRoot).catch(failStartup);
  serve(routes, portFlag ?? a.config.http?.port ?? 8787, (p) => maybeTunnel(a.definition.dir, p));
}

async function runStart(): Promise<void> {
  setLogLevel("info"); // production posture: info+, the debug turn trace (and its end-user content) gated out
  const portFlag = parsePort(values.port, "--port");
  loadDotEnv(dir);
  installProxyFetch();
  await resolveFirstRunModel(dir);

  // A `deploy fly --run` deploy may carry the operator's local credential as FASTAGENT_AUTH_SEED —
  // materialize it onto the writable state root BEFORE the opener resolves auth (once, absent-only).
  const authPathOverride = resolveAuthPathOverride(values["auth-path"]);
  await maybeSeedAuth(authPathOverride ?? defaultAuthPath(resolveStateRoot(dir)));

  // The same opener dev uses (single assembly source), just no watch.
  const sessionsDirOverride = resolveSessionsDirOverride(values["sessions-dir"]);
  const { agent, definition, config, modelSpec, stateRoot, sessionsDir, authPath, toolNames, toolCollisions } =
    await createPiAgentFromWorkspace(dir, {
      model: values.model,
      sessionsDir: sessionsDirOverride,
      authPath: authPathOverride,
    }).catch(failStartup);

  log.info(`[fastagent] start:  ${dir}`);
  log.info(`[fastagent] model:  ${modelSpec}`);
  await reportAuth(modelSpec, authPath);
  log.info(`[fastagent] agents: ${definition.instructions ? "AGENTS.md" : "(none)"}`);
  log.info(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (toolNames.length > 0) log.info(`[fastagent] tools:  ${toolNames.join(", ")}`);
  reportToolCollisions(toolCollisions);
  log.info(`[fastagent] state:  ${stateRoot}`);
  log.info(`[fastagent] sessions: ${sessionsDir}`);
  // State defaults under the definition dir, which a redeploy may replace wholesale. Gate on where the
  // root ACTUALLY resolved (in-tree?), not on the raw env var: an empty `FASTAGENT_STATE_DIR=""` reads
  // as unset (resolveStateRoot) and still lands in-tree, so a raw `=== undefined` check would wrongly
  // silence the warning. A sessions/auth override to a volume does not help — channel state (the
  // telegram turn/context files replay depends on) is still in-tree.
  if (isUnderDir(stateRoot, dir)) {
    log.info(
      `[fastagent] note: state (auth, sessions, channel state) lives under the definition dir; point ` +
        `FASTAGENT_STATE_DIR at a persistent volume so a redeploy that replaces the dir does not wipe it.`,
    );
  }
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);

  // Same debug turn trace as dev; gated out here by the info level (see serveOnce).
  const routes = await routesFor(dir, logAgentLoop(agent), stateRoot).catch(failStartup);
  serve(routes, portFlag ?? parsePort(process.env.PORT, "PORT env") ?? config.http?.port ?? 8787, (p) =>
    maybeTunnel(dir, p),
  );
  // No graceful drain: webhook turns run fire-and-forget; SIGTERM just exits mid-turn. Whether an
  // in-flight turn is LOST depends on the channel: the Telegram channel persists turn intent pre-ACK
  // and replays it next start (turn-store.ts, L1 durable execution, at-least-once); HTTP and other
  // channels have no such layer, so their in-flight turns are still lost (the asker re-invokes).
}

/**
 * The routes this deployment serves: a default `GET /health` plus the workspace's discovered
 * `channels/` — or the default invoke channel at POST /invoke when none are declared.
 */
async function routesFor(workspaceDir: string, agent: Agent, stateRoot: string): Promise<Routes> {
  const { routes, collisions } = await loadChannels(workspaceDir, { agent, stateRoot });
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
function serve(routes: Routes, port: number, onListening?: (boundPort: number) => void): void {
  serveNode(router(routes), { port }).listening.then(
    (boundPort) => {
      process.send?.({ type: "ready", port: boundPort }); // tell the dev supervisor we bound + on which port
      log.info(`[fastagent] http channel on :${boundPort}`);
      log.info(`[fastagent] routes: ${Object.keys(routes).join(", ") || "(none)"}`);
      onListening?.(boundPort);
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
