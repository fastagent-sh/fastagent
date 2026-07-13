#!/usr/bin/env node
/**
 * fastagent CLI — the product entry point and consumer of fastagent.config.ts. Process-level side
 * effects (proxy dispatcher, .env loading) belong here.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { autocomplete, isCancel, log as clackLog, password, select, text as clackText } from "@clack/prompts";
import { parseArgs } from "node:util";
import type { Agent } from "./agent.ts";
import { logAgentLoop } from "./observe.ts";
import { log, setLogLevel } from "./log.ts";
import { loadDotEnv, parseEnvContent } from "./env.ts";
import { installProxyFetch } from "./proxy.ts";
import { openExternalUrl } from "./open-url.ts";
import { createInvokeHandler } from "./channels/http.ts";
import { text } from "./channels/respond.ts";
import { type Routes, parseRouteKey, router, serveNode } from "./host/node.ts";
import { runDevSupervisor } from "./dev-supervisor.ts";
import { announceWebhooks, startCloudflareTunnel } from "./tunnel.ts";
import { discoverChannelFiles, loadChannels } from "./engines/pi/channel.ts";
import { detectRuntime, readPackageJson } from "./runtime.ts";
import { fastagentVersion } from "./version.ts";
import {
  defaultAuthPath,
  defaultSessionsDir,
  resolveStateRoot,
  isValidPort,
  listModels,
  loadConfig,
  resolveAgentDir,
  resolveAuthPath,
  resolveAuthPathOverride,
  resolveModelSpec,
  resolveSessionsDirOverride,
  rewriteConfigModel,
} from "./engines/pi/config.ts";
import { formatModelsCommand } from "./cli-models.ts";
import { formatAuthReport } from "./cli-auth.ts";
import { fastagentCredentialStore } from "./engines/pi/auth.ts";
import { type LoginIO, loginFlow } from "./engines/pi/login.ts";
import { configuredModelSpecs, createPiModels, probeAuthSource } from "./engines/pi/models.ts";
import { ensureStateRootSelfIgnored, isUnderDir, loadAgentDefinition } from "./engines/pi/definition.ts";
import { loadRootIgnore } from "./workspace.ts";
import { runInvokeStream } from "./invoke-stream.ts";
import { reportDefinitionWarnings, reportModuleLoadFailures, reportToolCollisions } from "./engines/pi/report.ts";
import { createPiAgentFromWorkspace } from "./engines/pi/workspace.ts";
import { resolveWorkspaceTools } from "./engines/pi/create.ts";
import {
  type ChannelKind,
  CHANNEL_KINDS,
  appendChannelDotEnv,
  appendChannelEnv,
  assertChannelReady,
  channelExists,
  channelSetup,
  scaffoldChannel,
} from "./scaffold/add-channel.ts";
import { detectHostSignals, exists, nextStepCd, scaffoldWorkspace } from "./scaffold/init.ts";
import { vendorSkill } from "./scaffold/vendor-skill.ts";
import { isGeneratedDockerfile } from "./deploy/container.ts";
import {
  parseFlyAppName,
  parseFlyMinMachines,
  parseFlyRegion,
  planFlyDeploy,
  toFlyAppName,
} from "./deploy/fly/plan.ts";
import { preflightDeploy } from "./deploy/preflight.ts";
import { planRailwayDeploy } from "./deploy/railway/plan.ts";
import { deployRailwayRun } from "./deploy/railway/run.ts";
import { authSeedBytes, deployFlyRun } from "./deploy/fly/run.ts";
import { spawnRunner } from "./deploy/runner.ts";
import { assembleSecrets } from "./deploy/secrets.ts";
import { createFeishuApi, isFeishuConfigApiMissing } from "./channels/feishu/feishu-api.ts";
import { cloudFor } from "./channels/feishu/cloud.ts";
import { bootstrapFeishuVerificationToken } from "./channels/feishu/bootstrap-token.ts";
import { registerFeishuApp } from "./channels/feishu/register-app.ts";
import { registerFeishuWebhook } from "./channels/feishu/register-webhook.ts";
import { onboardLarkApp } from "./channels/lark/onboard.ts";
import { registerTelegramWebhook } from "./channels/telegram/register-webhook.ts";
import { loadSchedules } from "./schedule/discover.ts";
import { readRuns } from "./schedule/audit.ts";
import { nextRun } from "./schedule/cron.ts";
import { listWakeups, removeWakeup } from "./schedule/wakeups.ts";
import { createScheduler, scheduleSession } from "./schedule/scheduler.ts";

function usage(code: number): never {
  console.error(`usage:
  fastagent init   [dir] [--minimal] [--no-install] [--flat] [--agent-dir <name>]
  fastagent models [search]
  fastagent info   [dir] [--json] [--auth-path file]
  fastagent tool   <name> '<json-args>' [dir]
  fastagent invoke <message> [dir] [--model provider/modelId] [--auth-path file]
  fastagent fire   <name> [dir] [--model provider/modelId] [--auth-path file]
  fastagent schedule history <name> [dir] [--json]
  fastagent schedule list [dir] [--json]
  fastagent schedule cancel <id> [dir]
  fastagent dev    [dir] [--port N] [--model provider/modelId] [--auth-path file] [--no-watch] [--tunnel]
  fastagent chat   [dir] [--model provider/modelId]
  fastagent start [dir] [--port N] [--model provider/modelId] [--sessions-dir dir] [--auth-path file] [--tunnel]
  fastagent add   github | telegram | feishu | lark | skill <source> [dir]
  fastagent deploy fly|railway [dir] [--run] [--force] [--stop] [--no-scale-to-zero] [--into-linked]
  fastagent login [provider] [--auth-path file]
  fastagent --version

  dev    assemble the agent in dir (default .) and serve a local HTTP channel. persona.md/AGENTS.md/
         skills are re-read every turn (edits go live next turn); edits to code inputs — tools/,
         channels/, fastagent.config.*, package.json, .env — restart the worker (--no-watch to
         disable). Files the agent writes as work product never trigger a restart.
         model precedence: --model > FASTAGENT_MODEL > fastagent.config.ts
         --tunnel  expose it on a public HTTPS URL via a Cloudflare quick tunnel (needs cloudflared)
                   and auto-register the webhook channels (telegram, feishu, lark; github prints the URL)
  chat   open the SAME assembled agent in pi's interactive TUI (the real harness, not a
         crude REPL) — to try it locally before serving. Same model/tool/skill resolution
         as dev; pi handles login, sessions, and /resume natively.
  init   scaffold a runnable agent in dir (default .) and run npm install. Default is a
         self-iterating agent: persona.md (its identity), a writing-great-skills example skill, a
         fetch-url code tool, config, package.json, .gitignore. Never overwrites existing files; an
         existing AGENTS.md is kept as project context. Layout: flat by default ("a directory is an
         agent"); when an existing toolchain/deploy claims the directory (tsconfig/framework config,
         a non-JS build manifest like go.mod/pyproject.toml/Cargo.toml, Dockerfile/fly/railway, or
         occupied tools/, channels/, or skills/), the kit goes into ./agent
         and config.agentDir points there — the reason is printed, no prompt.
         --minimal           persona.md + the example skill + config only (no code tool / package.json)
         --no-install        scaffold everything but skip npm install
         --flat              force the flat layout (skip detection)
         --agent-dir <name>  force the kit into ./<name>
  models list the available "provider/modelId" specs ([search] filters by substring; use one with
         --model or in the config).
  info   print what dir (default .) ASSEMBLES into — model, persona, context files (AGENTS.md), skills, tools (+ collisions),
         channels, sessions, load diagnostics — WITHOUT serving. Read-only (never creates sessions /
         writes .gitignore); an unset model is reported, not fatal. --json for CI. Run it first when
         something looks off.
  tool   run one tool (from tools/ or config.tools) directly with JSON args — no model, no
         server, no tokens. Fast feedback while authoring: fastagent tool add '{"a":2,"b":3}'
  invoke run ONE turn against the assembled agent and exit — no server, no TUI. The reply streams
         to stdout, tool/diagnostics to stderr, a failed turn exits non-zero. The all-agent
         counterpart of tool, for CI smoke and quick checks. Same model resolution as dev.
  fire   run ONE schedule's turn immediately (authoring loop, like invoke) — fires schedules/<name>.ts
         now without waiting for its cron. Reply→stdout; does NOT advance the schedule's fire state.
  schedule history <name>  print the run audit for a schedule (or "wake" for self-scheduled wake-ups):
         when each run fired, completed/failed/deferred, duration, and the reply/error — the answer to
         "did last night's run silently fail?". --json for the full records (complete reply text).
  schedule list    everything that will fire: static schedules (next instant) + pending wake-ups.
  schedule cancel <id>  remove a pending wake-up — the operator's kill switch for a runaway recurring
         wake (the agent's own is the \`unwake\` tool).
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
  add    github | telegram | feishu | lark: scaffold channels/<kind>.ts — third-party adapter glue
         with the policy to edit (github maps events in on(); telegram/feishu/lark route in the
         optional route()). Feishu (open.feishu.cn) is the canonical implementation; Lark international
         (open.larksuite.com) is its compatibility profile with degraded control-plane setup.
         feishu also CREATES + configures the platform app (confirm a link in the app — the platform's
         "scan to create" flow; one version-publish action remains) and writes credentials to .env;
         a persisted ID/Secret pair resumes missing-Token setup instead of creating another app. lark
         opens the intl developer console only for a new/partial pair, validates App ID/Secret, then
         probes Feishu's webhook-mode + Token automation; an explicit
         config-route 404 falls back to a hidden Token prompt + manual mode/URL setup.
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
    flat: { type: "boolean" },
    "agent-dir": { type: "string" },
    "no-watch": { type: "boolean" },
    tunnel: { type: "boolean" },
    "create-app": { type: "boolean" },
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
else if (command === "fire") await runFire();
else if (command === "schedule") await runScheduleCmd();
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
  // exercises exactly what gets served — a shadowed tool is surfaced, not silently run. Resolve agentDir
  // like the openers so `fastagent tool` finds the SAME tools/ as dev/start when config.agentDir is set.
  const agentDir = resolveAgentDir(toolDir, config);
  const { tools, toolCollisions, toolFailures } = await resolveWorkspaceTools(config, agentDir, toolDir).catch(
    failStartup,
  );
  for (const c of toolCollisions) {
    console.error(
      `[fastagent] warn: tool "${c.name}" (${c.source}) is shadowed by a default/config tool — not mounted`,
    );
  }
  reportModuleLoadFailures(toolFailures);
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

/**
 * `fastagent fire <name> [dir]`: run ONE schedule's turn immediately — the authoring loop for schedules
 * (like `invoke` is for a prompt). Fires `schedules/<name>.ts` now, without waiting for its cron, using
 * the schedule's stable session (faithful to the served behavior). Does NOT advance the schedule's fire
 * state — a test run must never make the scheduler skip the real next run.
 */
async function runFire(): Promise<void> {
  const name = positionals[1];
  if (!name) {
    console.error(`usage: fastagent fire <name> [dir]`);
    process.exit(2);
  }
  const fireDir = resolve(positionals[2] ?? ".");
  loadDotEnv(fireDir);
  installProxyFetch();
  await resolveFirstRunModel(fireDir);
  // Schedules are agent surface — discover them where dev/start/`schedule list` do (agentDir), not the
  // run root, so `fire` sees the same set the scheduler serves in the kit layout.
  const { config: fireConfig } = await loadConfig(fireDir).catch(failStartup);
  const fireAgentDir = resolveAgentDir(fireDir, fireConfig);
  const { schedules, failures } = await loadSchedules(fireAgentDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  const schedule = schedules.find((s) => s.name === name);
  if (!schedule) {
    // Name the discovery path in the kit layout: a schedule misplaced at the run root should read as
    // "wrong place", not "broken file".
    const looked =
      fireAgentDir === fireDir ? "" : ` (looked in ${relative(fireDir, fireAgentDir).split(sep).join("/")}/schedules)`;
    console.error(
      `unknown schedule "${name}"${looked}. available: ${schedules.map((s) => s.name).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }
  const { agent, modelSpec, authPath } = await createPiAgentFromWorkspace(fireDir, {
    model: values.model,
    authPath: resolveAuthPathOverride(values["auth-path"]),
  }).catch(failStartup);
  console.error(`[fastagent] fire: ${name} (${modelSpec})`);
  await reportAuth(modelSpec, authPath);
  const exitCode = await runInvokeStream(
    agent.invoke({ session: scheduleSession(name) }, { text: schedule.prompt }),
    (text) => process.stdout.write(text),
    (line) => console.error(line),
  );
  process.stdout.write("\n");
  process.exit(exitCode);
}

/**
 * `fastagent schedule history <name> [dir]`: print the run audit for one schedule (or "wake") — fired
 * time, outcome, duration, reply/error. Read-only (reads `<stateRoot>/schedule/runs.jsonl`); the answer
 * to "did last night's run silently fail?". Text mode previews the reply/error; --json is the full record.
 */
async function runScheduleCmd(): Promise<void> {
  const sub = positionals[1];
  if (sub === "list") return runScheduleList();
  if (sub === "cancel") return runScheduleCancel();
  const name = positionals[2];
  if (sub !== "history" || !name) {
    console.error(`usage: fastagent schedule history <name> | list | cancel <id>  [dir] [--json]`);
    process.exit(2);
  }
  const target = resolve(positionals[3] ?? ".");
  loadDotEnv(target); // FASTAGENT_STATE_DIR may live in .env — read the SAME state root the scheduler wrote
  const runs = readRuns(resolveStateRoot(target), name);
  if (values.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.error(`no recorded runs for "${name}" (state: ${resolveStateRoot(target)})`);
    return;
  }
  // The question is "did LAST NIGHT's run fail?" — so text mode tails the most recent runs (chronological
  // within the tail); --json above returns the full history.
  const TAIL = 20;
  const shown = runs.slice(-TAIL);
  if (runs.length > shown.length) {
    console.error(`(showing the last ${shown.length} of ${runs.length} runs — --json for all)`);
  }
  for (const r of shown) {
    const detail = r.error ?? r.reply ?? "";
    const preview = detail.replace(/\s+/g, " ").slice(0, 100);
    console.log(`${r.firedAt}  ${r.outcome.padEnd(9)} ${String(r.ms).padStart(6)}ms  ${preview}`);
  }
}

/** `fastagent schedule list [dir]`: everything that will fire — BOTH producers: the static `schedules/`
 *  files (with their next instant) and the agent's pending self-scheduled wake-ups. Read-only. */
async function runScheduleList(): Promise<void> {
  const target = resolve(positionals[2] ?? ".");
  loadDotEnv(target);
  const { config } = await loadConfig(target).catch(failStartup);
  const agentDir = resolveAgentDir(target, config);
  const { schedules, failures } = await loadSchedules(agentDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  const wakeups = listWakeups(resolveStateRoot(target));
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          schedules: schedules.map((s) => ({ ...s, next: nextRun(s.cron, s.tz, new Date())?.toISOString() })),
          wakeups,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (schedules.length === 0 && wakeups.length === 0) {
    console.error(`nothing scheduled — no schedules/ files, no pending wake-ups (state: ${resolveStateRoot(target)})`);
    return;
  }
  for (const s of schedules) {
    const next = nextRun(s.cron, s.tz, new Date())?.toISOString() ?? "(never)";
    console.log(`schedule  ${s.name.padEnd(20)} ${next}  cron ${s.cron}${s.tz ? ` ${s.tz}` : ""}`);
  }
  for (const w of wakeups) {
    const kind = w.cron ? `cron ${w.cron}${w.tz ? ` ${w.tz}` : ""}` : "one-shot";
    console.log(`wake      ${w.id}  ${w.fireAt}  ${kind}  session=${w.session}  ${w.prompt.slice(0, 60)}`);
  }
}

/** `fastagent schedule cancel <id> [dir]`: remove a pending wake-up — the operator's kill switch (the
 *  agent's own is the `unwake` tool). Unlike unwake it is NOT session-scoped: the operator owns the box. */
function runScheduleCancel(): void {
  const id = positionals[2];
  if (!id) {
    console.error(`usage: fastagent schedule cancel <id> [dir]`);
    process.exit(2);
  }
  const target = resolve(positionals[3] ?? ".");
  loadDotEnv(target);
  if (removeWakeup(resolveStateRoot(target), id)) {
    // ponytail: the store's load→save is lock-free — a serving scheduler's claim-advance can race this
    // write (window = ms around each fire). Tell the operator to verify; a lockfile/CAS is the upgrade
    // path if it ever bites.
    console.error(
      `[fastagent] cancelled wake-up ${id} — if a server is running, verify with \`fastagent schedule list\``,
    );
  } else {
    console.error(
      `no pending wake-up ${id} (state: ${resolveStateRoot(target)}) — \`fastagent schedule list\` shows ids`,
    );
    process.exit(1);
  }
}

/** `fastagent info [dir] [--json]`: print what the directory ASSEMBLES into, WITHOUT booting a server. Read-only. */
async function runInfo(): Promise<void> {
  loadDotEnv(dir); // skills/tools may read env at load time
  const { config, path: configPath } = await loadConfig(dir).catch(failStartup);
  const modelSpec = resolveModelSpec(values.model, config);
  // dir = the run root (cwd, whose AGENTS.md is ② context); the agent's own surface lives in agentDir.
  const agentDir = resolveAgentDir(dir, config);
  const definition = await loadAgentDefinition(agentDir, { cwd: dir }).catch(failStartup);
  // A tool that fails to load, for any reason (a missing dep, a top-level throw, or just not being a
  // tool), is isolated the same way everywhere (G2): info, dev, AND start report it and keep going with
  // the tools that loaded. The `error`/`.catch` below only fires for a whole-load fault (an unreadable
  // tools/ dir), not a single bad file.
  const tools = await resolveWorkspaceTools(config, agentDir, dir)
    .then((r) => ({
      names: r.toolNames,
      collisions: r.toolCollisions,
      failures: r.toolFailures,
      error: undefined as string | undefined,
    }))
    .catch((e: unknown) => ({ names: [] as string[], collisions: [], failures: [], error: (e as Error).message }));
  const channels = await discoverChannelFiles(agentDir).catch(failStartup);
  // Loaded (imported + validated), not just discovered: info's job is "fix only what it reports", so a
  // broken schedule file (bad cron/tz, failed import) must show up HERE, not first at dev/start — and
  // loading is what makes the next fire instant printable. Consistent with tools (info imports those too).
  const sched = await loadSchedules(agentDir).catch(failStartup);
  const schedules = sched.schedules.map((s) => ({
    name: s.name,
    cron: s.cron,
    tz: s.tz ?? null,
    next: nextRun(s.cron, s.tz, new Date())?.toISOString() ?? null,
  }));
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
          agentDir,
          configPath: configPath ?? null,
          model: modelSpec ?? null,
          context: definition.contextFiles.map((f) => f.path),
          persona: definition.persona !== undefined,
          skills: definition.skills.map((skill) => ({ name: skill.name, description: skill.description })),
          tools: tools.names,
          toolError: tools.error ?? null,
          channels,
          schedules,
          scheduleFailures: sched.failures,
          selfSchedule: config.selfSchedule ?? false,
          stateRoot,
          sessionsDir,
          authPath,
          diagnostics: definition.diagnostics,
          skillCollisions: definition.collisions,
          toolCollisions: tools.collisions,
          toolFailures: tools.failures,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`dir:      ${dir}`);
  if (agentDir !== dir) console.log(`agent:    ${agentDir}`);
  console.log(`config:   ${configPath ?? "(none)"}`);
  console.log(`model:    ${modelSpec ?? "(not set — pass --model, set FASTAGENT_MODEL, or config.model)"}`);
  console.log(`context:  ${definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  console.log(`persona:  ${definition.persona ? "persona.md" : "(none)"}`);
  console.log(`skills:   ${definition.skills.map((skill) => skill.name).join(", ") || "(none)"}`);
  console.log(`tools:    ${tools.error ? "(could not load — see warning below)" : tools.names.join(", ") || "(none)"}`);
  console.log(`channels: ${channels.join(", ") || "(none)"}`);
  console.log(`schedules: ${schedules.map((s) => `${s.name} (next ${s.next ?? "never"})`).join(", ") || "(none)"}`);
  console.log(`selfSchedule: ${config.selfSchedule ? "on (mounts the wake tool when serving)" : "off"}`);
  console.log(`state:    ${stateRoot}`);
  console.log(`sessions: ${sessionsDir}`);
  console.log(`auth:     ${authPath}`);
  reportToolCollisions(tools.collisions);
  reportModuleLoadFailures(tools.failures);
  reportModuleLoadFailures(sched.failures);
  if (tools.error) log.warn(`[fastagent] ${tools.error}`);
  reportDefinitionWarnings(definition.collisions, definition.diagnostics);
}

async function runInit(): Promise<void> {
  const minimal = values.minimal ?? false;
  // Layout: flags force; otherwise the jurisdiction rule decides (see detectHostSignals) and the reason
  // is printed. Deliberately no prompt — non-interactive executors (coding agents) get a deterministic
  // default they can read and override.
  if (values.flat && values["agent-dir"]) failStartup(new Error(`--flat and --agent-dir conflict — pick one`));
  let agentDir: string | undefined;
  let signals: string[] = [];
  if (values["agent-dir"]) {
    // Same containment contract loadConfig enforces on config.agentDir: an escaping value would write
    // the kit outside the workspace AND produce a config that can never load — refuse up front.
    // POSIX-normalized: this lands verbatim in the generated config (agentDir: "./a/b") and the persona
    // locator note — a Windows `relative()` would write backslashes into both.
    const rel = relative(dir, resolve(dir, values["agent-dir"])).split(sep).join("/");
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      failStartup(new Error(`--agent-dir ("${values["agent-dir"]}") must be a subdirectory of ${dir}`));
    }
    agentDir = `./${rel}`;
  } else if (!values.flat) {
    signals = await detectHostSignals(dir).catch(failStartup);
    if (signals.length > 0) agentDir = "./agent";
  }

  const { complete, created, skipped, patched, intoNonEmpty, warnings } = await scaffoldWorkspace(dir, {
    minimal,
    agentDir,
  }).catch(failStartup);
  // The layout reason prints only once the scaffold actually happened — an "already a workspace" refusal
  // must not be preceded by an announced decision that then never takes place.
  if (signals.length > 0) {
    console.error(
      `[fastagent] found ${signals.join(", ")} — an existing toolchain/deploy claims this directory, so the agent kit goes into ./agent (its own namespace; config.agentDir points there). cwd stays this directory. Override: --flat`,
    );
  }
  console.error(
    `[fastagent] initialized ${dir}${complete ? "" : " (minimal)"}${agentDir ? ` — agent kit in ${agentDir}` : ""}`,
  );
  if (created.length > 0) console.error(`  created: ${created.join(", ")}`);
  if (skipped.length > 0) console.error(`  kept existing: ${skipped.join(", ")}`);
  if (patched.length > 0) console.error(`  updated: ${patched.join(", ")} (missing fastagent excludes appended)`);
  if (intoNonEmpty && !agentDir) {
    console.error(
      `  note: scaffolded flat into a non-empty directory (nothing claims it — the directory is the agent); use --agent-dir <name> to put the kit in a subdir instead`,
    );
  }
  for (const w of warnings) console.error(`[fastagent] warn: ${w}`);

  // Install deps only for a complete agent whose package.json we just wrote (a kept one is not ours).
  // The manifest lives with the kit (agentDir when set), so the install runs there — never against a
  // host repo's own package.json.
  const kitDir = resolve(dir, agentDir ?? ".");
  const willInstall = complete && !values["no-install"] && created.includes(join(agentDir ?? ".", "package.json"));
  let installFailed = false;
  if (willInstall) {
    console.error(`[fastagent] installing dependencies (npm install${agentDir ? ` in ${agentDir}` : ""})…`);
    installFailed = (await npmInstall(kitDir)) !== 0;
    if (installFailed)
      console.error(`[fastagent] warn: npm install failed — run it manually in ${kitDir} before \`fastagent dev\``);
  }

  console.error(`  next steps:`);
  const cdTarget = nextStepCd(process.cwd(), dir);
  if (cdTarget) console.error(`    cd ${cdTarget}`);
  if (complete && (values["no-install"] || installFailed))
    console.error(`    ${agentDir ? `(cd ${agentDir} && npm install)` : "npm install"}`);
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
  const feishuCloud = channelKind === "feishu" || channelKind === "lark" ? cloudFor(channelKind) : undefined;
  // App creation is not a flag — it is what `add feishu` IS (the scan-to-create flow is the default
  // and only path there). The retired --create-app spelling gets a pointer, not silence.
  if (values["create-app"]) {
    if (channelKind === "feishu") {
      console.error(`[fastagent] note: --create-app is retired — \`add feishu\` creates the app by default`);
    } else if (channelKind === "lark") {
      failStartup(
        new Error(
          "--create-app is retired — `add lark` now opens the developer console and guides credential setup by default",
        ),
      );
    } else {
      failStartup(new Error("--create-app is retired — app creation is the default behavior of `add feishu`"));
    }
  }
  // The channel (glue + companion tool) is agent surface — it lands in agentDir (config.agentDir, or
  // target when flat), the same place dev/start discover channels/. .env(.example) and the secret
  // hygiene stay at the run root, where .env is actually read.
  const { config: addConfig } = await loadConfig(target).catch(failStartup);
  const channelHome = resolveAgentDir(target, addConfig);
  // Preconditions before the write, so a refusal is side-effect-free. feishu/lark are exceptions:
  // their add is scaffold + ONBOARD THE APP, so an existing scaffold skips the write and continues (a
  // failed or cancelled scan/paste flow must be re-runnable without hand-deleting glue); never touch it.
  const file = join(channelHome, "channels", `${channelKind}.ts`);
  if (await channelExists(channelHome, channelKind).catch(failStartup)) {
    if (channelKind !== "feishu" && channelKind !== "lark") {
      failStartup(new Error(`${relative(target, file)} already exists — edit it, or remove it to re-scaffold`));
    }
    console.error(`[fastagent] ${relative(target, file)} already exists — keeping it`);
  } else {
    await assertChannelReady(channelHome).catch(failStartup);
    await scaffoldChannel(channelHome, channelKind).catch(failStartup);
    console.error(`[fastagent] created ${relative(target, file)}`);
  }
  if (await appendChannelEnv(target, channelKind).catch(failStartup)) {
    console.error(`[fastagent] added ${channelKind} env vars to .env.example`);
  }
  // Secret hygiene: a channel's GENERATED secret (a random string the user contributes nothing to) is
  // written into `.env` — but only when `.env` is already gitignored: the CLI must never materialize a
  // secret into a committable file. Warn, not refuse, when it is exposed — channel glue may read a real
  // env var instead.
  const envIgnored = (await loadRootIgnore(target).catch(failStartup))?.ignores(".env") ?? false;
  if (!envIgnored) {
    console.error(
      `[fastagent] warn: .env is not gitignored — a deploy that copies the directory would ship a secret placed there; add .env to .gitignore/.fastagentignore, or use a real env var`,
    );
  }
  // `add feishu` = scaffold + CREATE OR RESUME the app. The irreversible App ID/Secret boundary is
  // persisted immediately inside createFeishuAppFlow, before its slower Token bootstrap. A re-run with
  // that complete pair resumes the SAME app; only a missing pair can enter scan-to-create again.
  let created: Record<string, string> | undefined;
  if (feishuCloud?.capabilities.appCreation === "scan-to-create") {
    if (!envIgnored) {
      failStartup(
        new Error(
          "`add feishu` creates an app and writes real credentials to .env — add .env to .gitignore/.fastagentignore first, then re-run",
        ),
      );
    }
    const existing = await activeDotEnvValues(target, [
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "FEISHU_VERIFICATION_TOKEN",
    ]).catch(failStartup);
    if (Object.keys(existing).length === 3) {
      console.error(`[fastagent] FEISHU_APP_ID/SECRET/VERIFICATION_TOKEN already set in .env — keeping them`);
    } else {
      await createFeishuAppFlow(target, existing).catch(failStartup);
    }
  } else if (feishuCloud?.capabilities.appCreation === "guided-console") {
    if (!envIgnored) {
      failStartup(
        new Error(
          "`add lark` writes real app credentials to .env — add .env to .gitignore/.fastagentignore first, then re-run",
        ),
      );
    }
    const existing = await activeDotEnvValues(target, [
      "LARK_APP_ID",
      "LARK_APP_SECRET",
      "LARK_VERIFICATION_TOKEN",
    ]).catch(failStartup);
    if (Object.keys(existing).length === 3) {
      console.error(`[fastagent] LARK_APP_ID/SECRET/VERIFICATION_TOKEN already set in .env — keeping them`);
    } else {
      if (!isInteractive()) {
        failStartup(
          new Error(
            "`add lark` needs an interactive terminal to onboard the Lark app credentials — re-run it in a terminal",
          ),
        );
      }
      created = await onboardLarkApp(
        {
          openUrl: openExternalUrl,
          note: (message) => clackLog.info(message),
          async prompt(message, opts) {
            const result = opts?.hidden ? await password({ message }) : await clackText({ message });
            return isCancel(result) ? undefined : (result as string);
          },
        },
        {
          existing,
          verifyCredentials: async (appId, appSecret) => {
            await createFeishuApi({
              kind: "lark",
              baseUrl: "https://open.larksuite.com",
              appId,
              appSecret,
            }).verifyCredentials();
            console.error(`[fastagent] Lark App ID / Secret verified`);
          },
          bootstrapWebhook: async (appId, appSecret) => {
            const api = createFeishuApi({
              kind: "lark",
              baseUrl: "https://open.larksuite.com",
              appId,
              appSecret,
            });
            console.error(`[fastagent] trying Lark's webhook-mode + Verification-Token bootstrap (temporary tunnel)…`);
            try {
              const token = await bootstrapFeishuVerificationToken({
                api,
                appId,
                kind: "lark",
                startTunnel: (port) => startCloudflareTunnel(port),
                onTunnelReady: (url) =>
                  console.error(`[fastagent] temporary tunnel ready → ${url}; registering webhook mode now…`),
                onPatchRetry: ({ error, attempt, attempts, retryMs }) =>
                  console.error(
                    `[fastagent] Lark could not validate the fresh tunnel yet (${String(error)}); retrying PATCH ${attempt + 1}/${attempts} in ${Math.round(retryMs / 1000)}s…`,
                  ),
                // A route-level 404 is definitive, not edge weather: fall back immediately. Retry
                // only actual edge/network weather; scope/auth/config failures remain immediate.
                shouldRetryPatch: (error) =>
                  !isFeishuConfigApiMissing(error) &&
                  /resolve host|getaddrinfo|ENOTFOUND|fetch failed|ECONNRESET|timeout|210042|request_url/i.test(
                    String(error),
                  ),
              });
              console.error(
                `[fastagent] Lark Verification Token captured; Subscription mode changed to webhook in the app draft`,
              );
              return { token };
            } catch (error) {
              if (!isFeishuConfigApiMissing(error)) throw error;
              const manualReason =
                "This Lark app returned HTTP 404 for the application-config API, so automatic mode/token bootstrap is unavailable.";
              console.error(`[fastagent] ${manualReason}`);
              return { manualReason };
            }
          },
        },
      ).catch(failStartup);
    }
  }
  const { env, steps } = channelSetup(channelKind);
  const generated = Object.fromEntries(
    env.filter((e) => e.generate).map((e) => [e.name, randomBytes(24).toString("hex")]),
  );
  // Kind-neutral: every channel's generated secrets get the same treatment (github's webhook secret is
  // the same class of value as telegram's); guided Lark credentials ride the same write as overwrites.
  // Feishu's irreversible credentials were already staged inside createFeishuAppFlow before bootstrap.
  const dotEnv = envIgnored
    ? await appendChannelDotEnv(target, channelKind, { ...generated, ...created }, Object.keys(created ?? {})).catch(
        failStartup,
      )
    : undefined;
  if (dotEnv && dotEnv.written.length > 0) {
    console.error(`[fastagent] wrote ${dotEnv.written.join(", ")} to .env`);
  }
  const install =
    detectRuntime(channelHome, await readPackageJson(channelHome)).runtime === "bun" ? "bun install" : "npm install";
  // The kit's manifest lives in channelHome (agentDir when set) — point the install there, not the run root.
  const installCmd = channelHome === target ? install : `(cd ${relative(target, channelHome)} && ${install})`;
  console.error(`  next steps:`);
  console.error(`    ${installCmd}                      # if @fastagent-sh/fastagent is not installed yet`);
  for (const e of env) {
    if (dotEnv?.alreadySet.includes(e.name)) continue; // the user already has it — nothing to do
    if (dotEnv?.written.includes(e.name)) {
      // Written, but its hint may still carry an action (github: paste the same value into the webhook
      // UI) — keep the variable visible instead of silently absorbing it.
      console.error(`    ${e.name} — ${e.generate ? "generated and " : ""}written to .env   # ${e.hint}`);
      continue;
    }
    const value = e.generate ? `=${generated[e.name]}` : "";
    const action = e.required ? "set" : "optionally set";
    console.error(`    ${action} ${e.name}${value} in .env${envIgnored ? " (gitignored)" : ""}   # ${e.hint}`);
  }
  // Steps carry `{channel}`/`{tools}` path placeholders (their filenames are the scaffold's private
  // knowledge) — resolve them to the real workspace-relative locations (agentDir-aware) here.
  const kitPrefix = channelHome === target ? "" : `${relative(target, channelHome)}/`;
  for (const s of steps) {
    console.error(`    ${s.replace("{channel}", relative(target, file)).replace("{tools}", `${kitPrefix}tools`)}`);
  }
  if (channelKind !== "lark") {
    console.error(`    fastagent dev --tunnel   # serve locally + a public URL, auto-registering the webhook`);
  }
  // The app-creation flow leaves keep-alive sockets behind (platform API fetches, the throwaway tunnel's
  // health probes) that would hold the event loop open for a while — the work is done, exit crisply.
  process.exit(0);
}

/**
 * The scan-to-create flow `add feishu` runs by default. The device-authorization grant
 * creates a pre-configured agent app (bot capability, messaging scopes, event subscriptions) when the
 * user confirms a link in the app, and hands back the credentials; App ID/Secret are persisted at that
 * irreversible boundary before the platform-generated Verification Token is captured from the
 * registration challenge (bootstrap-token.ts). The Token is persisted as a second stage, so .env is
 * complete before the one remaining version-publish action. The event Request URL is NOT left pointing at the throwaway
 * tunnel for long: `dev --tunnel` / `deploy --run` re-register it against the live URL.
 *
 * Feishu is the reference cloud and the only kind that runs this BOUND device flow. Lark is an explicit
 * compatibility profile: its lagging control plane uses the unbound launcher + guided credentials,
 * then probes the canonical token/mode bootstrap with a manual fallback.
 */
async function createFeishuAppFlow(target: string, existing: Readonly<Record<string, string>>): Promise<void> {
  let appId = existing.FEISHU_APP_ID;
  let appSecret = existing.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    console.error(`[fastagent] resuming Feishu app ${appId} from .env to capture its missing Verification Token`);
  } else {
    console.error(`[fastagent] creating the Feishu app (confirm in the app)…`);
    const app = await registerFeishuApp({
      name: "{user}'s agent", // the platform expands {user} to the confirming user's name; editable on the page
      desc: "Served by fastagent",
      // The agent template alone is not enough to SERVE: the v7 config PATCH (webhook auto-registration
      // in `dev --tunnel` / `deploy --run`) demands application:application:patch, and the app must
      // subscribe the receive event. Addons merge both onto the confirm page — no manual app setup.
      addons: {
        scopes: { tenant: ["application:application:patch"] },
        events: { items: { tenant: ["im.message.receive_v1"] } },
      },
      onVerificationUrl: ({ url, expiresInS }) => {
        console.error(
          `\n  Opening the confirmation link in your browser (or open it in Feishu / render it as a QR code) — valid for ${Math.round(expiresInS / 60)} minutes:\n\n    ${url}\n\n  waiting for confirmation… (keep this running — the credentials are delivered here)`,
        );
        openExternalUrl(url); // best-effort, like `login` — the URL above is the fallback
      },
    });
    console.error(`[fastagent] app created: ${app.appId}${app.tenantBrand ? ` (${app.tenantBrand} tenant)` : ""}`);
    // A cross-brand confirmation should be impossible (each confirm page refuses the other brand's
    // code) — but if the platform ever reports one, the credentials would land in the WRONG kind's env
    // namespace and serve the wrong cloud. Fail visibly instead of writing them.
    if (app.tenantBrand && app.tenantBrand !== "feishu") {
      throw new Error(
        `the confirming account is a ${app.tenantBrand} tenant, but this is \`add feishu\` — run \`fastagent add ${app.tenantBrand}\` instead`,
      );
    }
    appId = app.appId;
    appSecret = app.appSecret;

    // IRREVERSIBLE BOUNDARY: the remote app now exists and its one-time Secret is in memory. Persist
    // both before any config read, temporary tunnel, or Token bootstrap can be interrupted. Partial old
    // lines are overwritten because these newly-minted credentials are authoritative as one pair.
    await appendChannelDotEnv(
      target,
      "feishu",
      {
        FEISHU_APP_ID: appId,
        FEISHU_APP_SECRET: appSecret,
        // A Token from a partial OLD credential set belongs to another App. Clear it at the same
        // boundary; successful bootstrap below replaces the empty line with this App's Token.
        FEISHU_VERIFICATION_TOKEN: "",
      },
      ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
    );
    console.error(`[fastagent] wrote FEISHU_APP_ID, FEISHU_APP_SECRET to .env before Token bootstrap`);
  }

  // The webhook channel authenticates plaintext events by the platform-generated Verification Token.
  // Try the cheap read first (the v6 detail MAY someday return `encryption`), then the real path: the
  // token's only programmatic delivery is the url_verification challenge during registration — capture
  // it over a throwaway tunnel (bootstrap-token.ts). Failing both is a one-line manual copy; the staged
  // ID/Secret pair makes a re-run resume this App rather than mint another one.
  const tokenVar = "FEISHU_VERIFICATION_TOKEN";
  const api = createFeishuApi({ baseUrl: "https://open.feishu.cn", appId, appSecret });
  let token: string | undefined;
  let webhookModeChanged = false;
  try {
    const cfg = await api.getAppConfig(appId);
    token = cfg.verificationToken;
  } catch {
    /* the read surface is best-effort — the bootstrap below is the real path */
  }
  if (!token) {
    console.error(
      `[fastagent] capturing the Verification Token — a throwaway webhook registration delivers it (spinning up a temporary tunnel; can take a few minutes on a slow edge)…`,
    );
    try {
      token = await bootstrapFeishuVerificationToken({
        api,
        appId,
        startTunnel: (port) => startCloudflareTunnel(port),
      });
      webhookModeChanged = true;
      console.error(`[fastagent] Verification Token captured`);
    } catch (e) {
      // Transient tunnel weather is the usual cause. Do NOT suggest re-running `add feishu` as a new
      // scan: the staged pair makes the re-run resume THIS app; manual copy completes it too.
      console.error(
        `[fastagent] warn: could not capture the Verification Token: ${String(e)} — usually a transient tunnel issue; finish this app with the manual copy below`,
      );
    }
  }
  if (token) {
    // Persist the second credential stage immediately too — opening the publish page and generic
    // scaffold finalization happen only after the complete runtime credential set is durable.
    const staged = await appendChannelDotEnv(target, "feishu", { [tokenVar]: token }, [tokenVar]);
    console.error(`[fastagent] wrote ${staged.written.join(", ")} to .env`);
  } else {
    console.error(
      `[fastagent] copy it manually: developer console → Events & Callbacks → Encryption Strategy → Verification Token → ${tokenVar} in .env`,
    );
  }
  if (webhookModeChanged) {
    // The bootstrap's PATCH flipped event mode in the DRAFT. It takes effect only after a version
    // publish, which has no API; later dev/deploy runs change only the Request URL immediately.
    const versionUrl = `https://open.feishu.cn/app/${appId}/version`;
    console.error(
      `[fastagent] one console click remains: CREATE + PUBLISH a version (self-approved) — the switch to webhook mode takes effect on publish. Opening ${versionUrl}`,
    );
    openExternalUrl(versionUrl);
  }
}

/** Active run-root `.env` values for the requested names — decided by THE .env parser, so this
 * check can never disagree with what `loadEnvFile` reads. Empty/commented values are absent. */
async function activeDotEnvValues(dir: string, names: string[]): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(join(dir, ".env"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const parsed = parseEnvContent(content);
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = parsed.get(name)?.trim();
      return value ? [[name, value]] : [];
    }),
  );
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
  // Skills are agent surface — vendored into agentDir/skills (config.agentDir, or target when flat).
  const { config: skillConfig } = await loadConfig(target).catch(failStartup);
  const skillHome = resolveAgentDir(target, skillConfig);
  const { name, description, dest, hasScripts, diagnostics, overwritten } = await vendorSkill(skillHome, source, {
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
  console.error(`  next: mention "${name}" in persona.md so the model knows when to use it; then \`fastagent dev\``);
}

/**
 * `fastagent deploy <host> [dir]`: generate host artifacts from the resolved definition and print an
 * ordered deploy runbook. Host-scoped (`fly` | `railway` — the extension seam). It does NOT run the
 * host CLI: fastagent owns the two ends it uniquely knows (definition-aware artifacts; the post-deploy
 * webhook step), and hands the middle to a coding agent (or human) as a precise, values-resolved
 * runbook. The pre-flight (config/model/channels/container facts) is host-neutral; the host branch adds
 * its config file + runbook. Read-only on the definition; the only writes are the generated artifacts
 * (never clobbered without --force). `--run` drives the host CLI instead of printing.
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
  // The host-neutral pre-flight (model-travel gate, channel discovery, model-auth probe, container facts +
  // their warnings) lives in deploy/preflight.ts — testable in isolation. The CLI prints its messages and
  // stops on its gate; the host branch below adds only the host-specific artifacts + runbook + run drive.
  const pre = await preflightDeploy({
    target,
    agentDir: resolveAgentDir(target, config),
    config,
    modelSpec,
    run: !!values.run,
    force: !!values.force,
    authPathOverride: resolveAuthPathOverride(values["auth-path"]),
  }).catch(failStartup);
  if (!pre.ok) {
    console.error(`[fastagent] deploy stopped: ${pre.gate}`);
    process.exit(1);
  }
  for (const m of pre.messages) console.error(`[fastagent] ${m.level}: ${m.text}`);
  const { channels, hasTimeTriggers, modelAuth, authPath, container, port, extraSecrets } = pre;

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
    const plan = planRailwayDeploy({ serviceName, modelAuth, channels, extraSecrets, hasTimeTriggers, ...container });
    await writeArtifacts(target, plan.artifacts, { neverForce: container.kitDir ? [".dockerignore"] : [] });
    if (values.run) return runDeployRailway({ target, name: serviceName, modelAuth, authPath, channels, extraSecrets });
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
  // Kit layout: fly.toml lives under the kit (agent/fly.toml) — the host repo's own fly.toml (if any)
  // belongs to the host's product deploy and is never read or written here.
  const flyTomlPath = container.kitDir ? join(target, container.kitDir, "fly.toml") : join(target, "fly.toml");
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
  // KEEP mode + time triggers: the kept fly.toml may still scale to zero — which would sleep through every
  // cron instant / wake-up. The generated plan can't fix a kept file, so surface it instead of the preflight
  // note silently not applying (the author who deployed FIRST and added schedules LATER hits exactly this).
  // Under `--run` this is a GATE (same discipline as the model-travel gate): a full deploy whose schedules
  // silently never fire is worse than a crash-loop — nothing fails visibly when a cron instant passes on a
  // sleeping machine, and unlike github's min=0 there is no legitimate trade to accept here.
  if (flyTomlExists && !values.force && hasTimeTriggers) {
    const min = parseFlyMinMachines(await readFile(flyTomlPath, "utf8"));
    if ((min ?? 0) === 0) {
      // undefined = the line is absent — Fly's platform default for min_machines_running is 0, so a
      // hand-written fly.toml without the line scales to zero exactly like an explicit 0.
      const msg =
        `your kept fly.toml scales to zero (min_machines_running = ${min ?? "absent → platform default 0"}), but ` +
        `schedules/self-scheduling need a running machine (no external wake-up). Set min_machines_running = 1, ` +
        `or pass --force to regenerate.`;
      if (values.run) {
        console.error(`[fastagent] deploy stopped: ${msg}`);
        process.exit(1);
      }
      console.error(`[fastagent] warn: ${msg}`);
    }
  }
  const plan = planFlyDeploy({
    appName,
    port,
    modelAuth,
    channels,
    extraSecrets,
    hasTimeTriggers,
    ...container,
    autostop: values.stop ? "stop" : "suspend",
    scaleToZero: !values["no-scale-to-zero"],
  });
  await writeArtifacts(target, plan.artifacts, { neverForce: container.kitDir ? [".dockerignore"] : [] });
  if (values.run) return runDeployFly({ target, appName, modelAuth, authPath, channels, flyTomlPath, extraSecrets });
  console.log(plan.runbook.join("\n"));
}

/**
 * Write each generated artifact. An existing file is KEPT unless --force — deploy NEVER clobbers a file
 * without it (no silent data loss). A Dockerfile WE generated is derived from the current config, so a KEPT
 * one that no longer matches what deploy would generate now (a changed deploy.apt, a new lockfile, a bumped
 * version — OR the user's own edits, which we can't tell apart) is flagged stale so the drift is visible;
 * --force regenerates it. A hand-written Dockerfile / a hand-written .dockerignore / fly.toml's app+region
 * state are just kept.
 */
async function writeArtifacts(
  target: string,
  artifacts: { path: string; content: string }[],
  options: { neverForce?: string[] } = {},
): Promise<void> {
  for (const a of artifacts) {
    const abs = join(target, a.path);
    // Host-owned paths (the root .dockerignore in the agentDir layout): --force means "MY generated
    // artifact is authoritative", which never licenses clobbering the HOST's file — keep it always.
    if (options.neverForce?.includes(a.path) && (await exists(abs))) {
      console.error(
        `[fastagent] kept ${a.path} — the host repo's own file (never overwritten, even with --force); ` +
          `see the preflight warnings for what it must contain`,
      );
      continue;
    }
    if (!values.force && (await exists(abs))) {
      const existing = await readFile(abs, "utf8");
      if (a.path.endsWith("Dockerfile") && isGeneratedDockerfile(existing) && existing !== a.content) {
        console.error(
          `[fastagent] kept ${a.path} — it no longer matches what deploy would generate (config changed, or ` +
            `you edited it); pass --force to regenerate.`,
        );
      } else {
        console.error(`[fastagent] kept ${a.path} (exists — pass --force to overwrite)`);
      }
      continue;
    }
    await mkdir(dirname(abs), { recursive: true }); // kit-layout artifacts live under agent/
    await writeFile(abs, a.content);
    console.error(`[fastagent] wrote ${a.path}`);
  }
}

/**
 * `deploy fly --run`: drive flyctl to completion (idempotent, resumable). Gathers the secret VALUES
 * from the local env — the model key (env auth) or the whole auth.json as a `FASTAGENT_AUTH_SEED` seed
 * (OAuth/stored auth: the deployed box materializes it onto the /data volume on first boot, so a
 * personal deploy runs on the SAME subscription) plus channel secrets — then runs the flyctl steps
 * behind the shared {@link spawnRunner} seam (spawned `fly`, cwd = the workspace so the build context is the agent).
 */
async function runDeployFly(params: {
  target: string;
  appName: string;
  modelAuth: string | undefined;
  authPath: string;
  channels: ChannelKind[];
  flyTomlPath: string;
  extraSecrets: string[];
}): Promise<void> {
  const { target, appName, modelAuth, authPath, channels, flyTomlPath, extraSecrets } = params;
  const fly = spawnRunner("fly", target);
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
    extraSecrets,
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
    (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
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
async function runDeployRailway(params: {
  target: string;
  name: string;
  modelAuth: string | undefined;
  authPath: string;
  channels: ChannelKind[];
  extraSecrets: string[];
}): Promise<void> {
  const { target, name, modelAuth, authPath, channels, extraSecrets } = params;
  const railway = spawnRunner("railway", target);
  // Fail fast if the railway CLI is absent (spawn ENOENT → 127), with the install link.
  if ((await railway(["--version"], { capture: true })).code === 127) {
    console.error(`[fastagent] railway CLI not found — install it: https://docs.railway.com/guides/cli, then re-run`);
    process.exit(1);
  }

  const { secrets, missingSecrets, needsModelCredential } = assembleSecrets({
    modelAuth,
    authFile: (await exists(authPath)) ? await readFile(authPath) : undefined,
    channels,
    extraSecrets,
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
    (baseUrl, kind) => registerFeishuWebhook(baseUrl, kind),
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
  // login is inherently interactive — loginFlow renders provider/method menus and opens a browser (or
  // prompts for a key). In a non-TTY (a pipe, CI, a coding-agent shell) the menu can't receive keystrokes
  // and would hang. Fail fast with the reason instead of stalling on an unanswerable prompt. (After the
  // secret-hygiene self-ignore above, which is cheap prep, so a later terminal login is safe.)
  if (!isInteractive()) {
    console.error(
      `[fastagent] login is interactive (it shows a menu and opens a browser) — run it in a terminal, not a pipe/CI`,
    );
    process.exit(1);
  }
  const io = terminalLoginIO();
  const result = await loginFlow(io, { provider: positionals[1], authPath }).catch(failStartup);
  console.error(`[fastagent] logged in to ${result.provider} (${result.method}) — saved to ${authPath}`);
  process.exit(0); // the undici proxy agent's keep-alive sockets would otherwise hold the event loop open
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
    openUrl: openExternalUrl,
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
  // Only when nothing satisfies auth do we read the store (refresh-FREE) to tell "nothing stored" from
  // "stored but unusable" — see formatAuthReport for why. store.read warns on a corrupt file itself.
  const stored =
    source === undefined
      ? await fastagentCredentialStore(authPath)
          .read(provider)
          .catch(() => undefined)
      : undefined;
  const report = formatAuthReport(provider, authPath, source, stored);
  log.info(`[fastagent] ${report.line}`);
  if (report.warn) log.warn(`[fastagent] ${report.warn}`);
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

  const authPath = resolveAuthPath(workspaceDir, values["auth-path"]);
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
  log.info(`[fastagent] context: ${a.definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  if (a.definition.persona) log.info(`[fastagent] persona: persona.md`);
  log.info(`[fastagent] skills: ${a.definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (a.toolNames.length > 0) log.info(`[fastagent] tools:  ${a.toolNames.join(", ")}`);
  reportToolCollisions(a.toolCollisions);
  reportModuleLoadFailures(a.toolFailures);
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
  await runDevSupervisor(dir, { tunnel: values.tunnel ?? false });
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
    void announceWebhooks(workspaceDir, t.url, { openUrl: openExternalUrl });
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
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);
  log.info(`[fastagent] dir:    ${dir}`);
  if (a.agentDir !== dir) log.info(`[fastagent] agent:  ${a.agentDir}`);
  log.info(`[fastagent] config: ${a.configPath ?? "(zero-config)"}`);
  log.info(`[fastagent] model:  ${a.modelSpec}`);
  await reportAuth(a.modelSpec, a.authPath);
  reportAgentsSkillsTools(a);
  // Trace each turn's agent loop (tool calls + reply) to the log at debug level — shown in dev, gated
  // out in start (level info), keeping end-user content out of production logs. Wired in both postures.
  const traced = logAgentLoop(a.agent);
  const routes = await routesFor(a.agentDir, traced, a.stateRoot).catch(failStartup);
  await startSchedules(a.agentDir, traced, a.stateRoot, a.config.selfSchedule ?? false);
  serve(routes, portFlag ?? a.config.http?.port ?? 8787, (p) => maybeTunnel(a.agentDir, p));
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
  const {
    agent,
    definition,
    agentDir,
    config,
    modelSpec,
    stateRoot,
    sessionsDir,
    authPath,
    toolNames,
    toolCollisions,
    toolFailures,
  } = await createPiAgentFromWorkspace(dir, {
    model: values.model,
    sessionsDir: sessionsDirOverride,
    authPath: authPathOverride,
    serving: true, // long-running serve: the scheduler poller runs (wake mounts iff config.selfSchedule)
  }).catch(failStartup);

  log.info(`[fastagent] start:  ${dir}`);
  if (agentDir !== dir) log.info(`[fastagent] agent:  ${agentDir}`);
  log.info(`[fastagent] model:  ${modelSpec}`);
  await reportAuth(modelSpec, authPath);
  log.info(`[fastagent] context: ${definition.contextFiles.map((f) => f.path).join(", ") || "(none)"}`);
  if (definition.persona) log.info(`[fastagent] persona: persona.md`);
  log.info(`[fastagent] skills: ${definition.skills.map((s) => s.name).join(", ") || "(none)"}`);
  if (toolNames.length > 0) log.info(`[fastagent] tools:  ${toolNames.join(", ")}`);
  reportToolCollisions(toolCollisions);
  reportModuleLoadFailures(toolFailures);
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
  const traced = logAgentLoop(agent);
  const routes = await routesFor(agentDir, traced, stateRoot).catch(failStartup);
  await startSchedules(agentDir, traced, stateRoot, config.selfSchedule ?? false);
  serve(routes, portFlag ?? parsePort(process.env.PORT, "PORT env") ?? config.http?.port ?? 8787, (p) =>
    maybeTunnel(agentDir, p),
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
  const { routes, collisions, failures } = await loadChannels(workspaceDir, { agent, stateRoot });
  for (const c of collisions) {
    console.error(
      `[fastagent] warn: channel route "${c.route}" (${c.source}) collides with an earlier channel — not mounted`,
    );
  }
  reportModuleLoadFailures(failures);
  if (failures.length > 0 || collisions.length > 0) {
    throw new Error(
      `channel setup is invalid (${failures.length} load failure(s), ${collisions.length} route collision(s)) — ` +
        `fix it, or rename an intentionally disabled file to *.disabled`,
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

/**
 * Load and start the workspace's `schedules/` — a time-trigger firing the agent on each cron. Starts iff
 * there are static schedules OR `selfSchedule` is on (the scheduler also polls the agent's self-scheduled
 * wake-ups, which the built-in `wake` tool creates only when opted in). Shares the SAME (trace-wrapped)
 * agent the routes serve, so a scheduled turn is observed like any other. Best-effort stop on exit; dev's
 * watch restart re-reads schedules with the worker (schedules are a code input). Single-process.
 */
async function startSchedules(
  workspaceDir: string,
  agent: Agent,
  stateRoot: string,
  selfSchedule: boolean,
): Promise<void> {
  const { schedules, failures } = await loadSchedules(workspaceDir).catch(failStartup);
  reportModuleLoadFailures(failures);
  // Nothing to run when there are neither static `schedules/` nor self-scheduling (the `wake` tool, and
  // thus any wake-up to poll, is mounted only when config.selfSchedule is on) — skip the poller entirely.
  if (schedules.length === 0 && !selfSchedule) return;
  const scheduler = createScheduler({ agent, stateRoot, schedules });
  scheduler.start();
  if (schedules.length > 0) log.info(`[fastagent] schedules: ${schedules.map((s) => s.name).join(", ")}`);
  const stop = (): void => scheduler.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
